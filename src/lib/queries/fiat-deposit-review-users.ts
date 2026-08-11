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
  latestAuthAt: string | null;
  latestFingerprint: string | null;
  latestFingerprintEvent: string | null;
  fiatAutoApprovalEnabled: boolean;
  cleanFiatDeposits: number;
  reversedFiatDeposits: number;
  firstCleanFiatAt: string | null;
  accountClean: boolean;
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
    latest_auth_at: string | null;
    latest_fingerprint: string | null;
    latest_fingerprint_event: string | null;
    fiat_deposit_auto_approval_enabled: boolean | null;
    clean_fiat_deposits: number;
    reversed_fiat_deposits: number;
    first_clean_fiat_at: string | null;
    is_banned: boolean;
    is_locked: boolean;
    kyc_required: boolean;
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
      COALESCE(
        auth.latest_auth_at,
        CASE WHEN NULLIF(u.signup_ip, '') IS NOT NULL THEN u.created_at END
      )::text AS latest_auth_at,
      fingerprint.visitor_id AS latest_fingerprint,
      fingerprint.event_type AS latest_fingerprint_event,
      locks.fiat_deposit_auto_approval_enabled,
      fiat_history.clean_fiat_deposits,
      fiat_history.reversed_fiat_deposits,
      fiat_history.first_clean_fiat_at::text,
      u.is_banned,
      u.is_locked,
      COALESCE(kyc.kyc_required, false) AS kyc_required,
      locks.locked_deposits_fiat,
      locks.locked_withdrawals_crypto,
      locks.locked_withdrawals_items
    FROM "user" u
    LEFT JOIN user_feature_locks locks ON locks.user_id = u.id
    LEFT JOIN user_kyc kyc ON kyc.user_id = u.id
    LEFT JOIN LATERAL (
      SELECT fp.visitor_id, fp.event_type::text AS event_type
      FROM fingerprints fp
      WHERE fp.user_id = u.id
      ORDER BY fp.created_at DESC, fp.id DESC
      LIMIT 1
    ) fingerprint ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) FILTER (
          WHERE deposit.status::text = 'completed'
            AND deposit.paid_at IS NOT NULL
        )::int AS clean_fiat_deposits,
        COUNT(*) FILTER (
          WHERE deposit.status::text IN (
            'refunded', 'partially_refunded', 'disputed'
          )
        )::int AS reversed_fiat_deposits,
        MIN(deposit.paid_at) FILTER (
          WHERE deposit.status::text = 'completed'
            AND deposit.paid_at IS NOT NULL
        ) AS first_clean_fiat_at
      FROM fiat_deposit_intents deposit
      WHERE deposit.user_id = u.id
    ) fiat_history ON TRUE
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
          FILTER (WHERE audit.ip IS NOT NULL))[1] AS latest_auth_event,
        (array_agg(audit.created_at ORDER BY audit.created_at DESC)
          FILTER (WHERE audit.ip IS NOT NULL))[1] AS latest_auth_at
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
        latestAuthAt: row.latest_auth_at,
        latestFingerprint: row.latest_fingerprint,
        latestFingerprintEvent: row.latest_fingerprint_event,
        fiatAutoApprovalEnabled:
          row.fiat_deposit_auto_approval_enabled === true,
        cleanFiatDeposits: row.clean_fiat_deposits ?? 0,
        reversedFiatDeposits: row.reversed_fiat_deposits ?? 0,
        firstCleanFiatAt: row.first_clean_fiat_at,
        accountClean:
          row.is_banned !== true
          && row.is_locked !== true
          && row.kyc_required !== true,
        fiatDepositsLocked: row.locked_deposits_fiat === true,
        withdrawalsLocked:
          row.locked_withdrawals_crypto === true
          || row.locked_withdrawals_items === true,
      },
    ]),
  );
}
