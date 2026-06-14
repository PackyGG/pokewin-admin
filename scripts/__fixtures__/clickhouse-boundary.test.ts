import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Boundary guard: the ClickHouse read layer must never import a Postgres /
 * Prisma client. Reads the source as TEXT (does not import the modules, so the
 * server-only barrier is never tripped) and asserts none of the forbidden
 * imports appear.
 */
const CH_DIR = join(process.cwd(), "src", "lib", "clickhouse");

const FORBIDDEN_IMPORTS: { re: RegExp; label: string }[] = [
  { re: /from\s+["']@\/lib\/db["']/, label: "@/lib/db (Postgres game client)" },
  { re: /from\s+["']@\/lib\/admin-db["']/, label: "@/lib/admin-db (Postgres admin client)" },
  { re: /from\s+["']@\/generated\/(admin-)?prisma/, label: "generated Prisma client" },
  { re: /from\s+["']@prisma\//, label: "@prisma/*" },
  { re: /from\s+["']pg["']/, label: "pg" },
];

test("clickhouse read layer never imports Postgres/Prisma", () => {
  const files = readdirSync(CH_DIR).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length > 0, "expected ClickHouse modules in src/lib/clickhouse");

  for (const file of files) {
    const src = readFileSync(join(CH_DIR, file), "utf8");
    for (const { re, label } of FORBIDDEN_IMPORTS) {
      assert.ok(
        !re.test(src),
        `src/lib/clickhouse/${file} must not import ${label}`,
      );
    }
  }
});
