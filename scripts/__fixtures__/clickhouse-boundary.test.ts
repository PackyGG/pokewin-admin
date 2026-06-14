import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Boundary guard: the ClickHouse read layer must never import a Postgres /
 * Prisma DB CLIENT directly. Reads the source as TEXT (does not import the
 * modules, so the server-only barrier is never tripped) and asserts none of the
 * forbidden imports appear. Scans src/lib/clickhouse recursively.
 *
 * NOTE: the rule bans the DB *clients* (@/lib/db, @/lib/admin-db, pg, prisma).
 * Reusing a tiny higher-level control helper (e.g. getExcludedUserIds for the
 * blacklist) is allowed by design — pure analytics never reads Postgres.
 */
const CH_DIR = join(process.cwd(), "src", "lib", "clickhouse");

const FORBIDDEN_IMPORTS: { re: RegExp; label: string }[] = [
  { re: /from\s+["']@\/lib\/db["']/, label: "@/lib/db (Postgres game client)" },
  { re: /from\s+["']@\/lib\/admin-db["']/, label: "@/lib/admin-db (Postgres admin client)" },
  { re: /from\s+["']@\/generated\/(admin-)?prisma/, label: "generated Prisma client" },
  { re: /from\s+["']@prisma\//, label: "@prisma/*" },
  { re: /from\s+["']pg["']/, label: "pg" },
];

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

test("clickhouse read layer never imports a Postgres/Prisma client", () => {
  const files = collectTsFiles(CH_DIR);
  assert.ok(files.length > 0, "expected ClickHouse modules in src/lib/clickhouse");

  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const { re, label } of FORBIDDEN_IMPORTS) {
      assert.ok(!re.test(src), `${file} must not import ${label}`);
    }
  }
});
