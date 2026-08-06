import "server-only";

import { sql } from "drizzle-orm";

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
  return locked.rows.length > 0 ? "locked" : "skipped";
}
