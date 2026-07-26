import assert from "node:assert/strict";
import test from "node:test";

import { PgDialect } from "drizzle-orm/pg-core";

import type { MainDrizzleDb } from "../../src/lib/db";
import { queryRowsInTimeboxedTx } from "../../src/lib/drizzle-query";

test("timeboxed MAIN reads set read-only and a transaction-local timeout", async () => {
  const dialect = new PgDialect();
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    transaction: async (
      run: (tx: {
        execute: (statement: Parameters<PgDialect["sqlToQuery"]>[0]) => Promise<{
          rows: Array<{ ok: number }>;
        }>;
      }) => Promise<unknown>,
    ) =>
      run({
        execute: async (statement) => {
          const compiled = dialect.sqlToQuery(statement);
          statements.push({ sql: compiled.sql, params: compiled.params });
          return { rows: [{ ok: 1 }] };
        },
      }),
  } as unknown as MainDrizzleDb;

  const rows = await queryRowsInTimeboxedTx(db, 55_000, (query) =>
    query<Array<{ ok: number }>>("SELECT $1::int AS ok", 1),
  );

  assert.deepEqual(rows, [{ ok: 1 }]);
  assert.deepEqual(statements, [
    { sql: "SET TRANSACTION READ ONLY", params: [] },
    { sql: "SET LOCAL statement_timeout = 55000", params: [] },
    { sql: "SELECT $1::int AS ok", params: [1] },
  ]);
});

test("timeboxed MAIN reads reject unsafe timeout values before opening a transaction", async () => {
  let transactions = 0;
  const db = {
    transaction: async () => {
      transactions += 1;
    },
  } as unknown as MainDrizzleDb;

  for (const timeout of [0, -1, 1.5, Number.NaN, 120_001]) {
    await assert.rejects(
      queryRowsInTimeboxedTx(db, timeout, async () => null),
      /Invalid raised statement timeout/,
    );
  }
  assert.equal(transactions, 0);
});
