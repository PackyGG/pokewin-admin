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
  }>(sql`
    SELECT id AS user_id, username, email, country_code
    FROM "user"
    WHERE id = ANY(${pgArrayParam(uniqueIds)}::text[])
  `);

  return new Map(
    result.rows.map((row) => [
      row.user_id,
      {
        userId: row.user_id,
        username: row.username,
        email: row.email,
        countryCode: row.country_code,
      },
    ]),
  );
}
