import "server-only";

import { sql } from "drizzle-orm";

import { createAdminAuditEvent } from "@/lib/admin-audit";
import { getUserKyc, requireUserKyc } from "@/lib/backend-api/kyc";
import { getProdPrimaryDrizzleDb } from "@/lib/db";
import { logError } from "@/lib/errors/logger";

/**
 * Automatic containment for post-authorization Fiat deposit identity drift.
 *
 * This is the ONE place in the codebase where an automated signal requires KYC.
 * Every other containment path deliberately does not: `ingest/route.ts` used to
 * carry the blanket invariant "automated signals never mutate KYC state", and
 * the owner-contract test asserted it. The owner lifted that invariant for this
 * rule specifically (2026-07-30) — a payer whose card, email, or device stopped
 * matching the identity the account established on its first authorized deposit
 * has to prove who they are before the money moves again.
 *
 * The invariant still holds for every other kind. Nothing here is reachable
 * from the generic containment paths.
 *
 * Order matters: lock first, KYC second.
 *   • The lock is the part that actually stops money leaving, so it must not
 *     wait on a third-party API.
 *   • `requireUserKyc` re-locks withdrawals itself, so a lock-then-require
 *     sequence converges on the same state either way.
 *   • The panel's own manual KYC action refuses unless withdrawals are already
 *     locked (`isLockedAccountEligibleForKyc`). Locking first keeps the
 *     automated path consistent with the human one.
 */

/**
 * Admin the automatic KYC requirement is attributed to.
 *
 * The backend records `admin_id` on the KYC audit trail and has no concept of a
 * service account, so automated requirements are booked against the owner's
 * real admin user (`motha`). Changing this to an id that does not exist in the
 * admin table would make the backend reject every automated requirement.
 */
export const FIAT_IDENTITY_AUTOMATION_ADMIN_ID =
  "1336a279-971c-4089-a305-60f0313bf7cd";

/**
 * Containment rules this path is allowed to enforce.
 *
 * The monitor decides; this list is the dashboard's independent second opinion,
 * so a bug or a forged payload on the other side cannot invent a new reason to
 * lock an account and force KYC. Mirrors
 * `FIAT_IDENTITY_CONTAINMENT_REASONS` in the monitor's policy module.
 */
export const FIAT_IDENTITY_CONTAINMENT_REASONS = new Set([
  "checkout_email_domain_blacklisted",
  "checkout_ip_blocklisted",
  "checkout_fingerprint_blocklisted",
  "checkout_email_catchall",
  "checkout_email_undeliverable",
  "checkout_email_changed",
  "checkout_card_changed",
  "checkout_ip_and_device_changed",
]);

export type FiatIdentityContainmentTarget = {
  userId: string;
  intentId: string;
  reasons: string[];
  reason: string;
};

/**
 * Validate a containment signal and build the target, or return null.
 *
 * Pure so the whole admission decision is unit-testable without a database.
 */
export function fiatIdentityContainmentTarget(signal: {
  userId?: string | null;
  riskScore?: number | null;
  payload?: Record<string, unknown> | null;
}): FiatIdentityContainmentTarget | null {
  const userId = signal.userId;
  const payload = signal.payload ?? {};
  const rawReasons = payload.reasonCodes;
  const reasons = Array.isArray(rawReasons)
    ? rawReasons.filter(
        (reason): reason is string =>
          typeof reason === "string"
          && FIAT_IDENTITY_CONTAINMENT_REASONS.has(reason),
      )
    : [];
  const intentId =
    typeof payload.intentId === "string" ? payload.intentId : null;
  if (
    !userId
    || !intentId
    || payload.containmentRequired !== true
    || payload.requireKyc !== true
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
    intentId,
    reasons,
    reason: (
      "Automatic fraud lock: authorized Fiat deposit identity changed ("
      + `${reasons.join(", ")})`
    ).slice(0, 500),
  };
}

export type FiatIdentityContainmentOutcome = {
  locked: boolean;
  /** 'required' | 'already_required' | 'failed' | 'not_attempted' */
  kyc: "required" | "already_required" | "failed" | "not_attempted";
};

/**
 * Lock the money rails for one account, then require KYC.
 *
 * `*_at` / `*_reason` are COALESCEd so a repeat containment never overwrites the
 * first lock's reason or timestamp — or a human's.
 */
export async function applyFiatIdentityContainment(
  target: FiatIdentityContainmentTarget,
): Promise<FiatIdentityContainmentOutcome> {
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
  if (locked.rows.length === 0) {
    // Account deleted between the monitor's verdict and this delivery.
    return { locked: false, kyc: "not_attempted" };
  }

  const kyc = await requireKycForContainment(target);
  return { locked: true, kyc };
}

/**
 * Require KYC, tolerating a backend that is down.
 *
 * Never throws. The lock — the part that stops money leaving — is already
 * committed by the time this runs, and a KYC-service outage must not roll the
 * delivery back into a retry that would re-lock the account and open a second
 * verification cycle. On failure the analyst still gets the Discord alert, and
 * the Fiat workspace's existing one-click Require KYC finishes the job.
 */
async function requireKycForContainment(
  target: FiatIdentityContainmentTarget,
): Promise<FiatIdentityContainmentOutcome["kyc"]> {
  try {
    const current = await getUserKyc(target.userId);
    // Re-requiring would open a fresh verification cycle and invalidate the
    // documents the player may already have submitted.
    if (current.kycRequired) return "already_required";
  } catch (error) {
    logError(
      "antifraud.fiatIdentity.kycReadback",
      `KYC state unreadable for ${target.userId}; lock stands, KYC deferred`,
      error,
    );
    return "failed";
  }

  const reason = (
    `Automatic Fiat deposit identity review: ${target.intentId} `
    + `(${target.reasons.join(", ")})`
  ).slice(0, 500);
  try {
    const result = await requireUserKyc({
      userId: target.userId,
      adminId: FIAT_IDENTITY_AUTOMATION_ADMIN_ID,
      reason,
    });
    await mirrorKycAudit(target, result.verificationCycle);
    return "required";
  } catch (error) {
    logError(
      "antifraud.fiatIdentity.requireKyc",
      `automatic KYC requirement failed for ${target.userId}; lock stands`,
      error,
    );
    return "failed";
  }
}

/**
 * Mirror the requirement into the ADMIN audit trail under the same event type
 * the human KYC actions use, so the per-user audit view and the fiat
 * workspace's history pick it up without a second vocabulary.
 */
async function mirrorKycAudit(
  target: FiatIdentityContainmentTarget,
  verificationCycle: number,
): Promise<void> {
  try {
    await createAdminAuditEvent({
      adminUserId: FIAT_IDENTITY_AUTOMATION_ADMIN_ID,
      eventType: "user_kyc_required",
      targetUserId: target.userId,
      metadata: {
        source: "antifraud_fiat_identity_containment",
        automated: true,
        depositIntentId: target.intentId,
        reasonCodes: target.reasons,
        verificationCycle,
      },
    });
  } catch (error) {
    // The backend owns the authoritative KYC audit trail; a failed secondary
    // mirror must not present a successful requirement as failed.
    logError(
      "antifraud.fiatIdentity.kycAudit",
      `secondary KYC audit mirror failed for ${target.userId}`,
      error,
    );
  }
}
