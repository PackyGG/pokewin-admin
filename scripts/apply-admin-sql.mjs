#!/usr/bin/env node

import "dotenv/config";

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import pg from "pg";

const argv = process.argv.slice(2);
// `--force` re-runs (and re-stamps) a file the ledger already knows about. It
// exists because these migrations are written idempotent, so deliberately
// replaying one is a legitimate workflow — it just must not be the default,
// or the ledger records nothing useful.
const force = argv.includes("--force");
const positional = argv.filter((value) => value !== "--force");
const relativeFile = positional[0];
if (!relativeFile || positional.length !== 1) {
  throw new Error(
    "Usage: npm run admin:sql -- <path-to-reviewed-admin-migration.sql> [--force]",
  );
}

const connectionString = process.env.ADMIN_DATABASE_URL?.trim();
if (!connectionString) {
  throw new Error("ADMIN_DATABASE_URL is required");
}
if (
  [process.env.DATABASE_URL, process.env.DATABASE_URL_POOLED]
    .flatMap((value) => (value ? [value.trim()] : []))
    .includes(connectionString)
) {
  throw new Error(
    "Refusing to run: ADMIN_DATABASE_URL matches the read-only MAIN DATABASE_URL",
  );
}

const workspaceRoot = process.cwd();
const migrationPath = path.resolve(workspaceRoot, relativeFile);
const relativeMigrationPath = path.relative(workspaceRoot, migrationPath);
const migrationsRoot = path.resolve(
  workspaceRoot,
  "drizzle",
  "admin",
  "migrations",
);
if (
  path.dirname(migrationPath) !== migrationsRoot ||
  path.extname(migrationPath).toLowerCase() !== ".sql"
) {
  throw new Error(
    "Migration must be a .sql file directly under drizzle/admin/migrations",
  );
}

const migrationSql = await readFile(migrationPath, "utf8");
if (migrationSql.trim().length === 0) {
  throw new Error("Migration SQL is empty");
}
if (migrationSql.charCodeAt(0) === 0xfeff) {
  throw new Error("Migration SQL must be UTF-8 without a byte-order mark");
}
if (/^\s*(?:COMMIT|ROLLBACK)(?:\s+WORK)?\s*;/im.test(migrationSql)) {
  throw new Error("Migration SQL must not control its wrapper transaction");
}

const migrationVersion = path.basename(migrationPath);
// Normalise line endings before hashing: the same reviewed migration checked
// out on Windows would otherwise hash differently and read as "edited since it
// was applied".
const migrationChecksum = createHash("sha256")
  .update(migrationSql.replace(/\r\n/g, "\n"), "utf8")
  .digest("hex");

/**
 * Applied-migration ledger.
 *
 * Without one there is no way to answer "is this file live?" — the apply path
 * recorded nothing, and the checked-in introspection snapshot is hand-edited
 * often enough that it is not an oracle either. That is how an ADMIN migration
 * sat unapplied without anything noticing. Mirrors the pattern the antifraud
 * service already uses (services/antifraud-monitor/src/migrate.ts).
 */
const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS admin_schema_migrations (
  version text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

const client = new pg.Client({
  connectionString,
  application_name: "pokewin-admin-migrate",
  connectionTimeoutMillis: 10_000,
  keepAlive: true,
});
await client.connect();

try {
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '10s'");
  await client.query("SET LOCAL statement_timeout = '120s'");
  // Everything below runs under the advisory lock, so two concurrent applies
  // cannot both read "not applied yet" and both run the body.
  await client.query("SELECT pg_advisory_xact_lock($1)", [1_729_264_536]);
  await client.query(LEDGER_DDL);

  const recorded = await client.query(
    "SELECT checksum FROM admin_schema_migrations WHERE version = $1",
    [migrationVersion],
  );
  const priorChecksum = recorded.rows[0]?.checksum;
  if (priorChecksum && priorChecksum !== migrationChecksum && !force) {
    throw new Error(
      `Refusing to run: ${migrationVersion} is already recorded as applied with a DIFFERENT checksum. ` +
        "Author a new migration for the change, or re-run with --force if the edit is provably a no-op.",
    );
  }
  if (priorChecksum && !force) {
    // Commit anyway: the ledger DDL above may be the only work this
    // transaction did, and it should survive.
    await client.query("COMMIT");
    console.log(
      `Already applied, skipping: ${relativeMigrationPath} (checksum matches the ledger)`,
    );
  } else {
    await client.query(migrationSql);
    await client.query(
      `INSERT INTO admin_schema_migrations (version, checksum)
       VALUES ($1, $2)
       ON CONFLICT (version)
       DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()`,
      [migrationVersion, migrationChecksum],
    );
    await client.query("COMMIT");
    console.log(`Applied admin migration: ${relativeMigrationPath}`);
  }
} catch (error) {
  // The skip path above already committed; ROLLBACK on a finished transaction
  // is a no-op warning, so never let it mask the real error.
  await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  await client.end();
}
