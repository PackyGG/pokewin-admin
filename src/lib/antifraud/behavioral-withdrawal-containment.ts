import "server-only";

import { sql } from "drizzle-orm";

import { createAdminAuditEventDurable } from "@/lib/admin-audit";
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
  if (locked.rows.length === 0) return "skipped";

  await recordBehavioralContainmentAudit(target);
  return "locked";
}

/**
 * ADMIN-side record that an unattended system restricted this account.
 *
 * Filed under a dedicated automatic event type, never the staff vocabulary:
 * `antifraud_withdrawals_locked` is the Fraud workspace's operator trail
 * ("one row = one staff decision"), and `locked_withdrawals_*_enabled` is read
 * by the critical-signup watchdog as a terminal staff release. Writing either
 * from here would present automation as an operator and stand that watchdog
 * down.
 *
 * `createAdminAuditEventDurable` retries, falls back to
 * `admin_audit_write_failures`, alerts, and never throws — MAIN is already
 * locked at this point, so a failed mirror must not turn an applied
 * containment into an outbox failure that retries the whole apply.
 */
async function recordBehavioralContainmentAudit(
  target: BehavioralWithdrawalContainmentTarget,
): Promise<void> {
  await createAdminAuditEventDurable({
    adminUserId: null,
    eventType: "antifraud_containment_locked",
    targetUserId: target.userId,
    // Explicit null: the only address in scope on this path belongs to the
    // monitor delivering the command, never to the contained account, and an
    // `ip` column that looks like the user's would misdirect a later review.
    ip: null,
    metadata: {
      source: "antifraud_containment",
      kind: "behavioral_withdrawal_containment",
      // The matched policy code and score are carried inside `reason` — the
      // target exposes no other identifier, and the raw signal stays in
      // `antifraud_signals`.
      reason: target.reason,
      lockedWithdrawals: true,
    },
  });
}
