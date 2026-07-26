import assert from "node:assert/strict";
import { test } from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { positionalSql } from "../../src/lib/sql/positional";

const dialect = new PgDialect();

function compile(query: string, values: readonly unknown[]) {
  return dialect.sqlToQuery(positionalSql(query, values));
}

test("positional SQL binds repeated and multi-digit placeholders", () => {
  const values = Array.from({ length: 10 }, (_, index) => `value-${index + 1}`);
  const compiled = compile(
    "SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10",
    values,
  );

  assert.equal(
    compiled.sql,
    "SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11",
  );
  assert.deepEqual(compiled.params, [...values, "value-10"]);
});

test("positional SQL keeps arrays as one PostgreSQL parameter", () => {
  const values = ["open", "in_review", "escalated"];
  const compiled = compile(
    "SELECT 1 WHERE status = ANY($1::text[])",
    [values],
  );

  assert.equal(
    compiled.sql,
    "SELECT 1 WHERE status = ANY($1::text[])",
  );
  assert.deepEqual(compiled.params, [values]);
});

test("positional SQL ignores dollar text in quoted regions and comments", () => {
  const compiled = compile(
    `SELECT '$10–50', "$2", $$ body $3 $$, $tag$ body $4 $tag$, $1
     -- ignored $5
     /* ignored $6 /* nested $7 */ */`,
    ["bound"],
  );

  assert.match(compiled.sql, /'\$10–50'/);
  assert.match(compiled.sql, /"\$2"/);
  assert.deepEqual(compiled.params, ["bound"]);
});

test("positional SQL rejects missing and unused values", () => {
  assert.throws(
    () => compile("SELECT $2", ["only-one"]),
    /Missing SQL bind value for \$2/,
  );
  assert.throws(
    () => compile("SELECT $1", ["used", "unused"]),
    /Unused SQL bind value/,
  );
});

test("positional SQL rejects unterminated quoted regions", () => {
  assert.throws(
    () => compile("SELECT 'broken $1", ["value"]),
    /Unterminated SQL quoted value/,
  );
  assert.throws(
    () => compile("SELECT /* broken $1", ["value"]),
    /Unterminated SQL block comment/,
  );
  assert.throws(
    () => compile("SELECT $tag$ broken $1", ["value"]),
    /Unterminated SQL dollar-quoted value/,
  );
});
