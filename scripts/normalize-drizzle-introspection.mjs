#!/usr/bin/env node

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const target = process.argv[2];
if (target !== "main" && target !== "admin") {
  throw new Error("Usage: node scripts/normalize-drizzle-introspection.mjs <main|admin>");
}

const directory = path.resolve("src", "lib", "db-schema", target);
const schemaPath = path.join(directory, "schema.ts");
const metaPath = path.join(directory, "meta", "0000_snapshot.json");
const baselineName = (await readdir(directory)).find(
  (name) => /^0000_.+\.sql$/.test(name),
);
if (!baselineName) throw new Error(`No Drizzle baseline found for ${target}`);
const baselinePath = path.join(directory, baselineName);

function normalizeArrayDefaults(source) {
  return source.replace(
    /([A-Za-z_][A-Za-z0-9_]*)\(\)\.array\(\)\.default\(\["(?:|RAY)"\]\)/g,
    (_, type) => `${type}().array().default(sql\`'{}'::${type}[]\`)`,
  );
}

/**
 * drizzle-kit emits an EMPTY-STRING column default as `.default(')` — an
 * unterminated string literal that makes the entire schema module fail to
 * parse, taking `tsc` down with it.
 *
 * It is not cosmetic and it is not rare: `discord_notification_events
 * .description` triggers it on EVERY introspection, and a broken schema.ts
 * reached the working tree twice on 2026-08-06 before anyone noticed, each time
 * surfacing as a pile of confusing TS1005s in an unrelated agent's session.
 * Normalising it here means the next `db:pull:admin` can't reintroduce it.
 */
function normalizeEmptyStringDefaults(source) {
  return source.replace(/\.default\('\)/g, ".default('')");
}

function normalizeCustomTypes(source) {
  if (target === "main") {
    if (!source.includes("customType }")) {
      source = source.replace(
        /, pgEnum } from "drizzle-orm\/pg-core"/,
        ', pgEnum, customType } from "drizzle-orm/pg-core"',
      );
    }
    if (!source.includes("const oid = customType")) {
      source = source.replace(
        'import { sql } from "drizzle-orm"\n',
        'import { sql } from "drizzle-orm"\n\nconst oid = customType<{ data: number }>({\n\tdataType() {\n\t\treturn "oid";\n\t},\n});\n',
      );
    }
    source = source
      .replace(
        /\t\/\/ TODO: failed to parse database type 'oid'\r?\n\tuserid: unknown\("userid"\),/,
        '\tuserid: oid("userid"),',
      )
      .replace(
        /\t\/\/ TODO: failed to parse database type 'oid'\r?\n\tdbid: unknown\("dbid"\),/,
        '\tdbid: oid("dbid"),',
      )
      .replace(
        /\tforeignKey\(\{\r?\n\t\t\tcolumns: \[table\.bet_ledger_tx_id\],\r?\n\t\t\tforeignColumns: \[ledger_transactions\.id\],\r?\n\t\t\tname: "game_sessions_bet_ledger_tx_id_ledger_transactions_id_fk"\r?\n\t\t\}\)\.onDelete\("set null"\),\r?\n/,
        "",
      )
      .replace(
        /foreignColumns: \[ledger_transactions\.id\],(\r?\n\s+name: "creator_stream_sessions_activation_ledger_id_fkey")/g,
        "foreignColumns: [ledger_transactions.id as AnyPgColumn],$1",
      )
      .replace(
        /foreignColumns: \[game_sessions\.id\],(\r?\n\s+name: "ledger_transactions_game_session_id_game_sessions_id_fk")/g,
        "foreignColumns: [game_sessions.id as AnyPgColumn],$1",
      );
    return source;
  }

  if (!source.includes("customType }")) {
    source = source.replace(
      /, pgEnum } from "drizzle-orm\/pg-core"/,
      ', pgEnum, customType } from "drizzle-orm/pg-core"',
    );
  }
  if (!source.includes("const bytea = customType")) {
    source = source.replace(
      'import { sql } from "drizzle-orm"\n',
      'import { sql } from "drizzle-orm"\n\nconst bytea = customType<{ data: Buffer }>({\n\tdataType() {\n\t\treturn "bytea";\n\t},\n});\n',
    );
  }
  return source
    .replace(
      /\t\/\/ TODO: failed to parse database type 'bytea'\r?\n\tprofile_image: unknown\("profile_image"\),/,
      '\tprofile_image: bytea("profile_image"),',
    )
    .replace(
      /\t\/\/ TODO: failed to parse database type 'bytea'\r?\n\tpublic_key: unknown\("public_key"\)\.notNull\(\),/,
      '\tpublic_key: bytea("public_key").notNull(),',
    );
}

let schema = await readFile(schemaPath, "utf8");
schema = normalizeCustomTypes(
  normalizeEmptyStringDefaults(normalizeArrayDefaults(schema)),
);
if (/\.(?:array\(\))\.default\(\["(?:|RAY)"\]\)/.test(schema)) {
  throw new Error(`Unnormalized array default remains in ${schemaPath}`);
}
// Fail loudly rather than writing a file that cannot parse. Anything still
// matching here is a NEW shape of the same drizzle-kit bug, and a thrown error
// is far cheaper to diagnose than the TS1005 cascade it would otherwise cause.
if (/\.default\('\)/.test(schema)) {
  throw new Error(`Unterminated string default remains in ${schemaPath}`);
}
await writeFile(schemaPath, schema, "utf8");

let baseline = await readFile(baselinePath, "utf8");
baseline = baseline
  .replace(/DEFAULT '\{""\}'/g, "DEFAULT '{}'")
  .replace(/DEFAULT '\{"RAY"\}'/g, "DEFAULT '{}'");
await writeFile(baselinePath, baseline, "utf8");

let snapshot = await readFile(metaPath, "utf8");
snapshot = snapshot
  .replace(/"default": "'\{\\"\\"\}'"/g, `"default": "'{}'"`)
  .replace(/"default": "'\{\\"RAY\\"\}'"/g, `"default": "'{}'"`);
await writeFile(metaPath, snapshot, "utf8");

console.log(`Normalized Drizzle ${target} introspection artifacts.`);
