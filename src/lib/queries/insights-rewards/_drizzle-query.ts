import { sql, type SQL } from "drizzle-orm";
import type { MainDrizzleDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";

export { sql };

const SAFE_COLUMN = /^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?$/i;

function columnSql(column: string): SQL {
  if (!SAFE_COLUMN.test(column)) {
    throw new Error(`Unsafe SQL column identifier: ${column}`);
  }
  return sql.raw(column);
}

export async function queryRows<
  T extends Record<string, unknown>[],
>(db: MainDrizzleDb, query: SQL): Promise<Array<T[number]>> {
  const result = await db.execute<T[number]>(query);
  return result.rows;
}

export function blacklistNotInSql(
  column: string,
  ids: readonly string[],
): SQL {
  if (ids.length === 0) return sql.raw("");
  // Bind as text: every column this targets is a `text` user id (`"user".id`,
  // `affiliate_code_usages.affiliate_user_id`), and packy.gg ids are not UUIDs.
  // A `::uuid` cast here made PostgreSQL fail the whole query with
  // `42883 operator does not exist: text <> uuid` for any non-empty blacklist.
  // Matches the canonical `blacklistNotInClause` in `../_blacklist.ts`.
  return sql`AND ${columnSql(column)} NOT IN (${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )})`;
}

export function daysAgoFilter(column: string, days: number | null): SQL {
  return days === null
    ? sql.raw("")
    : sql`AND ${columnSql(column)} >= NOW() - (${days} * INTERVAL '1 day')`;
}

export async function realCustomersScopeDrizzle(): Promise<SQL> {
  const excluded = await getExcludedUserIds();
  const blacklist = blacklistNotInSql("u.id", [...excluded].sort());
  return sql`(SELECT id
              FROM "user" u
              WHERE u.role NOT IN ('admin', 'support', 'creator')
                ${blacklist})`;
}
