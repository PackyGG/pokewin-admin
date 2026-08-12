import "server-only";

import { sql } from "drizzle-orm";

import { createAdminAuditEventDurable } from "@/lib/admin-audit";
import { getProdPrimaryDrizzleDb } from "@/lib/db";

/**
 * Turn Fiat deposits off and lock withdrawals for an account the automatic
 * checkout assessment refused. Deliberately does NOT ban, does not touch
 * `is_locked`, does not kill sessions and never mutates KYC: the account keeps
 * working, its money rails do not, and staff decide the rest from the review
 * this same delivery opens.
 *
 * Split into a pure validator (`fiatEligibilityContainmentTarget`) and the
 * actual MAIN-DB write (`applyFiatEligibilityContainment`) so the admission
 * decision can run inside the ADMIN ingest transaction — no MAIN I/O — while
 * the MAIN write itself runs strictly after that transaction commits. Mirrors
 * the same split already used by `fiat-identity-containment.ts`.
 */

/**
 * Containment rules the automatic Fiat-checkout endpoint is allowed to enforce.
 * The monitor decides; this list is the dashboard's independent second opinion,
 * so a bug or a forged payload on the other side cannot invent a new reason to
 * lock an account. It validates against invented reasons; it is not a veto on
 * legitimate ones, so every reason the policy emits with `containing: true`
 * must appear here. `services/antifraud-monitor/test/fiat-eligibility.test.ts`
 * ("every containment reason is one the dashboard will honour") reads both
 * sides from source and fails on drift.
 */
export const FIAT_ELIGIBILITY_CONTAINMENT_REASONS = new Set([
  "new_account_checkout_ip_changed",
  "new_account_checkout_device_changed",
  "checkout_identity_changed_with_bad_reputation",
  "checkout_identity_changed_from_latest_login_with_bad_reputation",
  "repeat_fiat_within_sixty_seconds",
  "blocklist_ip_match",
  "blocklist_fingerprint_match",
  "blocklist_email_domain_match",
  "whop_prior_dispute_or_refund",
  "fingerprint_event_replayed",
  "fingerprint_linked_id_mismatch",
  "fingerprint_bad_bot",
]);

export type FiatEligibilityContainmentTarget = {
  userId: string;
  reasons: string[];
  reason: string;
};

/**
 * Validate a containment signal and build the target, or return null.
 *
 * Pure so the whole admission decision is unit-testable without a database,
 * and so it is safe to run inside the ADMIN ingest transaction (no MAIN I/O).
 */
export function fiatEligibilityContainmentTarget(signal: {
  userId?: string | null;
  riskScore?: number | null;
  payload?: Record<string, unknown> | null;
}): FiatEligibilityContainmentTarget | null {
  const userId = signal.userId;
  const payload = signal.payload ?? {};
  const rawReasons = payload.reasonCodes;
  const reasons = Array.isArray(rawReasons)
    ? rawReasons.filter(
        (reason): reason is string =>
          typeof reason === "string"
          && FIAT_ELIGIBILITY_CONTAINMENT_REASONS.has(reason),
      )
    : [];
  if (
    !userId
    || payload.containmentRequired !== true
    || payload.environment !== "prod"
    || signal.riskScore == null
    || signal.riskScore < 70
    || signal.riskScore > 100
    || reasons.length === 0
  ) {
    return null;
  }

  return {
    userId,
    reasons,
    reason: (
      "Automatic fraud lock: Fiat checkout assessment matched "
      + reasons.join(", ")
    ).slice(0, 500),
  };
}

/**
 * Apply the lock in MAIN. Both leg sets use COALESCE on `*_at` / `*_reason` so
 * a repeat containment never overwrites the first (or a human's) reason and
 * timestamp — safe to re-run for retries.
 */
export async function applyFiatEligibilityContainment(
  target: FiatEligibilityContainmentTarget,
): Promise<"locked" | "skipped"> {
  const db = getProdPrimaryDrizzleDb();
  const locked = await db.execute<{ user_id: string }>(sql`
    INSERT INTO user_feature_locks (
      id, user_id,
      locked_deposits_fiat, locked_deposits_at, locked_deposits_by,
      locked_deposits_reason,
      locked_withdrawals_crypto, locked_withdrawals_items,
      locked_withdrawals_at, locked_withdrawals_by,
      locked_withdrawals_reason,
      created_at, updated_at
    )
    SELECT
      ${crypto.randomUUID()}, u.id,
      ARRAY['all']::text[], NOW(), NULL, ${target.reason},
      ARRAY['all']::text[], TRUE, NOW(), NULL, ${target.reason},
      NOW(), NOW()
    FROM "user" u
    WHERE u.id = ${target.userId}
    ON CONFLICT (user_id) DO UPDATE SET
      locked_deposits_fiat = ARRAY['all']::text[],
      locked_deposits_at = COALESCE(
        user_feature_locks.locked_deposits_at,
        EXCLUDED.locked_deposits_at
      ),
      locked_deposits_reason = COALESCE(
        user_feature_locks.locked_deposits_reason,
        EXCLUDED.locked_deposits_reason
      ),
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

  await recordFiatEligibilityContainmentAudit(target);
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
async function recordFiatEligibilityContainmentAudit(
  target: FiatEligibilityContainmentTarget,
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
      kind: "fiat_eligibility_containment",
      reasonCodes: target.reasons,
      reason: target.reason,
      lockedFiatDeposits: true,
      lockedWithdrawals: true,
    },
  });
}
