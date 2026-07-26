import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { pgArrayParam } from "../../src/lib/drizzle-array-param";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const absolute = path.join(directory, entry);
    if (statSync(absolute).isDirectory()) return sourceFiles(absolute);
    return /\.[cm]?[jt]sx?$/.test(entry) ? [absolute] : [];
  });
}

test("pgArrayParam compiles an array as one PostgreSQL parameter", () => {
  const dialect = new PgDialect();
  const query = dialect.sqlToQuery(sql`
    SELECT 1
    WHERE 'open' = ANY(${pgArrayParam(["open", "flagged"])}::text[])
  `);

  assert.match(query.sql, /ANY\(\$1::text\[\]\)/);
  assert.deepEqual(query.params, [["open", "flagged"]]);
  assert.doesNotMatch(query.sql, /\(\$1,\s*\$2\)/);
});

test("tagged SQL never interpolates a bare JavaScript array", () => {
  const unsafe: string[] = [];
  const bareArrayCast =
    /(?<!\$)\$\{(?!pgArrayParam\()[^}\r\n]+\}::[A-Za-z_][A-Za-z0-9_]*\[\]/g;
  const bareAnyAll =
    /\b(?:ANY|ALL)\s*\(\s*(?<!\$)\$\{(?!pgArrayParam\()[^}\r\n]+\}/g;

  for (const file of sourceFiles(path.join(root, "src"))) {
    const source = readFileSync(file, "utf8");
    if (bareArrayCast.test(source) || bareAnyAll.test(source)) {
      unsafe.push(path.relative(root, file).replaceAll("\\", "/"));
    }
    bareArrayCast.lastIndex = 0;
    bareAnyAll.lastIndex = 0;
  }

  assert.deepEqual(unsafe, []);
});

