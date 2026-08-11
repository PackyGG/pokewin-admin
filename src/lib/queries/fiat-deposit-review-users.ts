import "server-only";

import { sql } from "drizzle-orm";

import { readDrizzleForEnv } from "@/lib/db";
import { readDbEnv } from "@/lib/db-env";
import { pgArrayParam } from "@/lib/drizzle-array-param";

export type FiatDepositReviewUser = {
  userId: string;
  username: string | null;
  email: string | null;
  signupEmail: string | null;
  countryCode: string | null;
  latestAuthIp: string | null;
  latestAuthEvent: "login" | "register" | null;
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
    signup_email: string | null;
    country_code: string | null;
    latest_auth_ip: string | null;
    latest_auth_event: "login" | "register" | null;
    locked_deposits_fiat: boolean | null;
    locked_withdrawals_crypto: boolean | null;
    locked_withdrawals_items: boolean | null;
  }>(sql`
    SELECT
      u.id AS user_id,
      u.username,
      u.email,
      COALESCE(auth.signup_email, u.email) AS signup_email,
      u.country_code,
      COALESCE(auth.latest_auth_ip, NULLIF(u.signup_ip, '')) AS latest_auth_ip,
      COALESCE(
        auth.latest_auth_event,
        CASE WHEN NULLIF(u.signup_ip, '') IS NOT NULL THEN 'register' END
      ) AS latest_auth_event,
      locks.locked_deposits_fiat,
      locks.locked_withdrawals_crypto,
      locks.locked_withdrawals_items
    FROM "user" u
    LEFT JOIN user_feature_locks locks ON locks.user_id = u.id
    LEFT JOIN LATERAL (
      SELECT
        (array_agg(audit.metadata->>'email' ORDER BY audit.created_at)
          FILTER (
            WHERE audit.event_type = 'register'
              AND NULLIF(audit.metadata->>'email', '') IS NOT NULL
          ))[1] AS signup_email,
        (array_agg(host(audit.ip) ORDER BY audit.created_at DESC)
          FILTER (WHERE audit.ip IS NOT NULL))[1] AS latest_auth_ip,
        (array_agg(audit.event_type::text ORDER BY audit.created_at DESC)
          FILTER (WHERE audit.ip IS NOT NULL))[1] AS latest_auth_event
      FROM audit_events audit
      WHERE audit.user_id = u.id
        AND audit.event_type IN ('login', 'register')
    ) auth ON TRUE
    WHERE u.id = ANY(${pgArrayParam(uniqueIds)}::text[])
  `);

  return new Map(
    result.rows.map((row) => [
      row.user_id,
      {
        userId: row.user_id,
        username: row.username,
        email: row.email,
        signupEmail: row.signup_email,
        countryCode: row.country_code,
        latestAuthIp: row.latest_auth_ip,
        latestAuthEvent: row.latest_auth_event,
        fiatDepositsLocked: row.locked_deposits_fiat === true,
        withdrawalsLocked:
          row.locked_withdrawals_crypto === true
          || row.locked_withdrawals_items === true,
      },
    ]),
  );
}
