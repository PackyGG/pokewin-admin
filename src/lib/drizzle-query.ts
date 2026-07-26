import { getDrizzleDb, type MainDrizzleDb } from "@/lib/db";
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

/** Request-scoped MAIN read for modules that keep SQL in `$n` form. */
export async function queryMainRows<T extends Record<string, unknown>[]>(
  query: string,
  ...values: readonly unknown[]
): Promise<T> {
  return queryRows<T>(await getDrizzleDb(), query, ...values);
}
