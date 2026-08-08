import "server-only";

import { sql } from "drizzle-orm";

import { readDrizzleForEnv } from "@/lib/db";
import { readDbEnv } from "@/lib/db-env";
import { pgArrayParam } from "@/lib/drizzle-array-param";

export type FiatDepositReviewUser = {
  userId: string;
  username: string | null;
  email: string | null;
  countryCode: string | null;
  fiatDepositsLocked: boolean;
  withdrawalsLocked: boolean;
};

export async function getFiatDepositReviewUsers(
  userIds: readonly string[],
): Promise<Map<string, FiatDepositReviewUser>> {
  const uniqueIds = [...new Set(userIds.filter(Boolean))];
  if (uniqueIds.length === 0) return new Map();

  const db = readDrizzleForEnv(await readDbEnv());
  const result = await db.execute<{
    user_id: string;
    username: string | null;
    email: string | null;
    country_code: string | null;
    locked_deposits_fiat: boolean | null;
    locked_withdrawals_crypto: boolean | null;
    locked_withdrawals_items: boolean | null;
  }>(sql`
    SELECT
      u.id AS user_id,
      u.username,
      u.email,
      u.country_code,
      locks.locked_deposits_fiat,
      locks.locked_withdrawals_crypto,
      locks.locked_withdrawals_items
    FROM "user" u
    LEFT JOIN user_feature_locks locks ON locks.user_id = u.id
    WHERE u.id = ANY(${pgArrayParam(uniqueIds)}::text[])
  `);

  return new Map(
    result.rows.map((row) => [
      row.user_id,
      {
        userId: row.user_id,
        username: row.username,
        email: row.email,
        countryCode: row.country_code,
        fiatDepositsLocked: row.locked_deposits_fiat === true,
        withdrawalsLocked:
          row.locked_withdrawals_crypto === true
          || row.locked_withdrawals_items === true,
      },
    ]),
  );
}
