import { sql } from "drizzle-orm";

import { getDrizzleDb, type MainDrizzleDb } from "@/lib/db";
import {
  decodePostgresRows,
  type PostgresDecoder,
} from "@/lib/postgres-runtime";
import { positionalSql } from "@/lib/sql/positional";

type DrizzleExecutor = Pick<MainDrizzleDb, "execute">;

/**
 * Execute trusted PostgreSQL text while preserving the `$n` convention used
 * by existing callers. Runtime values are always bound by Drizzle.
 */
export async function queryRows<T extends Record<string, unknown>[]>(
  db: DrizzleExecutor,
  query: string,
  ...values: readonly unknown[]
): Promise<T> {
  const result = await db.execute<T[number]>(positionalSql(query, values));
  return result.rows as unknown as T;
}

/**
 * Strict raw-query boundary for result types that PostgreSQL may serialize as
 * strings (timestamps, NUMERIC, BIGINT and JSON). Prefer this over an unchecked
 * `queryRows<T>` generic whenever a row crosses into application code.
 */
export async function queryDecodedRows<T>(
  db: DrizzleExecutor,
  query: string,
  values: readonly unknown[],
  decoder: PostgresDecoder<T>,
): Promise<T[]> {
  const result = await db.execute<Record<string, unknown>>(
    positionalSql(query, values),
  );
  return decodePostgresRows(result.rows, decoder);
}

/** Request-scoped MAIN read for modules that keep SQL in `$n` form. */
export async function queryMainRows<T extends Record<string, unknown>[]>(
  query: string,
  ...values: readonly unknown[]
): Promise<T> {
  return queryRows<T>(await getDrizzleDb(), query, ...values);
}

export async function queryMainDecodedRows<T>(
  query: string,
  values: readonly unknown[],
  decoder: PostgresDecoder<T>,
): Promise<T[]> {
  return queryDecodedRows(await getDrizzleDb(), query, values, decoder);
}

/** A `$n`-style MAIN read bound to one transaction's connection. */
export type TxQuery = <T extends Record<string, unknown>[]>(
  query: string,
  ...values: readonly unknown[]
) => Promise<T>;

/** Upper bound for a raised per-statement budget, as a sanity guard. */
const MAX_STATEMENT_TIMEOUT_MS = 120_000;

/**
 * Run trusted MAIN reads on one connection in a READ ONLY transaction with a
 * raised per-statement timeout. `SET LOCAL` reverts automatically at commit.
 */
export async function queryRowsInTimeboxedTx<T>(
  db: MainDrizzleDb,
  statementTimeoutMs: number,
  run: (query: TxQuery) => Promise<T>,
): Promise<T> {
  if (
    !Number.isInteger(statementTimeoutMs) ||
    statementTimeoutMs <= 0 ||
    statementTimeoutMs > MAX_STATEMENT_TIMEOUT_MS
  ) {
    throw new Error(
      `Invalid raised statement timeout: ${statementTimeoutMs}ms (expected an integer in 1..${MAX_STATEMENT_TIMEOUT_MS})`,
    );
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql.raw("SET TRANSACTION READ ONLY"));
    await tx.execute(
      sql.raw(`SET LOCAL statement_timeout = ${statementTimeoutMs}`),
    );
    return run((query, ...values) => queryRows(tx, query, ...values));
  });
}

/** Request-scoped variant for callers outside `unstable_cache` callbacks. */
export async function queryMainRowsInTimeboxedTx<T>(
  statementTimeoutMs: number,
  run: (query: TxQuery) => Promise<T>,
): Promise<T> {
  return queryRowsInTimeboxedTx(
    await getDrizzleDb(),
    statementTimeoutMs,
    run,
  );
}
