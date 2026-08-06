import "server-only";

import { sql } from "drizzle-orm";

import { getProdPrimaryDrizzleDb } from "@/lib/db";

/**
 * Withdrawal lock for `behavioral_withdrawal_containment`. The allowlist is
 * the dashboard's independent second opinion on reasons the monitor may emit
 * with `containmentRequired: true`. Never mutates KYC.
 */

export const BEHAVIORAL_CONTAINMENT_REASONS = new Set([
  "cluster.fingerprint_third_account",
  "cluster.exact_ip_third_account",
  "promotion.third_redemption",
  "network.tor",
  "device.confirmed_vm",
  "fingerprint.replayed",
  "fingerprint.identity_mismatch",
  "fingerprint.automation",
  "funds.restricted_downstream_active_use",
  "fresh-third-promo-redemption",
  "fresh_creator_tip",
  "fresh_sponsored_battle",
  "score_priority_policy",
  "maxmind_score_alert",
]);

export type BehavioralWithdrawalContainmentTarget = {
  userId: string;
  reason: string;
};

/**
 * Pure admission check — safe inside the ADMIN ingest transaction.
 */
export function behavioralWithdrawalContainmentTarget(signal: {
  userId?: string | null;
  riskScore?: number | null;
  payload?: Record<string, unknown> | null;
}): BehavioralWithdrawalContainmentTarget | null {
  const userId = signal.userId;
  const payload = signal.payload ?? {};
  const reasonCode =
    typeof payload.reasonCode === "string" ? payload.reasonCode : null;
  if (
    !userId ||
    signal.riskScore == null ||
    signal.riskScore < 70 ||
    signal.riskScore > 100 ||
    payload.containmentRequired !== true ||
    !reasonCode ||
    !BEHAVIORAL_CONTAINMENT_REASONS.has(reasonCode)
  ) {
    return null;
  }

  return {
    userId,
    reason: (
      `Automatic fraud lock: behavioral policy ${reasonCode} ` +
      `matched at risk ${signal.riskScore}/100`
    ).slice(0, 500),
  };
}

export async function applyBehavioralWithdrawalContainment(
  target: BehavioralWithdrawalContainmentTarget,
): Promise<"locked" | "skipped"> {
  const db = getProdPrimaryDrizzleDb();
  const locked = await db.execute<{ user_id: string }>(sql`
    INSERT INTO user_feature_locks (
      id, user_id, locked_withdrawals_crypto, locked_withdrawals_items,
      locked_withdrawals_at, locked_withdrawals_by,
      locked_withdrawals_reason, created_at, updated_at
    )
    SELECT
      ${crypto.randomUUID()}, u.id, ARRAY['all']::text[], TRUE,
      NOW(), NULL, ${target.reason}, NOW(), NOW()
    FROM "user" u
    WHERE u.id = ${target.userId}
    ON CONFLICT (user_id) DO UPDATE SET
      locked_withdrawals_crypto = ARRAY['all']::text[],
      locked_withdrawals_items = TRUE,
      locked_withdrawals_at = COALESCE(
        user_feature_locks.locked_withdrawals_at,
        EXCLUDED.locked_withdrawals_at
      ),
      locked_withdrawals_reason = COALESCE(
        user_feature_locks.locked_withdrawals_reason,
        EXCLUDED.locked_withdrawals_reason
      ),
      updated_at = NOW()
    RETURNING user_id
  `);
  return locked.rows.length > 0 ? "locked" : "skipped";
}
