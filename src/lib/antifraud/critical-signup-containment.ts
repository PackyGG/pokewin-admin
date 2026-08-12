import "server-only";

import { sql } from "drizzle-orm";

import { createAdminAuditEventDurable } from "@/lib/admin-audit";
import { adminDrizzle } from "@/lib/admin-db";
import {
  getUserFeatureLocks,
  updateUserRewardLocks,
  type RewardLockCategory,
} from "@/lib/backend-api/feature-locks";
import { getProdPrimaryDrizzleDb } from "@/lib/db";
import { logError } from "@/lib/errors/logger";

/**
 * Critical signup containment: Fiat deposits + withdrawals in MAIN, then tip
 * lock via the backend reward-lock API. Never mutates KYC.
 */

export const CRITICAL_SIGNUP_ACTIONS = [
  "lock_fiat_deposits",
  "lock_withdrawals",
  "lock_tips",
] as const;

export type CriticalSignupContainmentTarget = {
  userId: string;
  reason: string;
};

/**
 * Pure admission check — safe inside the ADMIN ingest transaction.
 */
export function criticalSignupContainmentTarget(signal: {
  userId?: string | null;
  riskScore?: number | null;
  payload?: Record<string, unknown> | null;
}): CriticalSignupContainmentTarget | null {
  const userId = signal.userId;
  const payload = signal.payload ?? {};
  const rawActions = Array.isArray(payload.actions) ? payload.actions : [];
  const validActions = new Set(
    rawActions.filter((action): action is string => typeof action === "string"),
  );
  if (
    !userId ||
    signal.riskScore == null ||
    signal.riskScore < 70 ||
    signal.riskScore > 100 ||
    payload.riskBand !== "critical" ||
    payload.reasonCode !== "critical_signup_score" ||
    payload.containmentRequired !== true ||
    validActions.size !== CRITICAL_SIGNUP_ACTIONS.length ||
    !CRITICAL_SIGNUP_ACTIONS.every((action) => validActions.has(action))
  ) {
    return null;
  }

  return {
    userId,
    reason: (
      `Automatic fraud lock: critical signup scored ${signal.riskScore}/100`
    ).slice(0, 500),
  };
}

/**
 * MAIN feature locks first, then backend tip lock. Throws on tip-lock failures
 * so the outbox records `failed` and the cron retries (MAIN COALESCE makes
 * the lock leg idempotent).
 */
export async function applyCriticalSignupContainment(
  target: CriticalSignupContainmentTarget,
): Promise<"locked" | "skipped"> {
  const db = getProdPrimaryDrizzleDb();
  const locked = await db.execute<{
    user_id: string;
    locked_deposits_fiat: string[];
    locked_withdrawals_crypto: string[];
    locked_withdrawals_items: boolean;
  }>(sql`
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
    RETURNING
      user_id,
      locked_deposits_fiat,
      locked_withdrawals_crypto,
      locked_withdrawals_items
  `);
  const confirmedMain = locked.rows[0];
  if (!confirmedMain) return "skipped";
  if (
    !confirmedMain.locked_deposits_fiat.includes("all")
    || !confirmedMain.locked_withdrawals_crypto.includes("all")
    || confirmedMain.locked_withdrawals_items !== true
  ) {
    throw new Error("MAIN did not confirm every critical signup feature lock");
  }

  const current = await getUserFeatureLocks(target.userId);
  if (!current.available_reward_categories.includes("tips")) {
    throw new Error("Backend does not expose the tips reward lock");
  }
  if (!current.locked_reward_categories.includes("tips")) {
    const nextLocks = Array.from(
      new Set<RewardLockCategory>([
        ...current.locked_reward_categories,
        "tips",
      ]),
    );
    const updated = await updateUserRewardLocks(
      target.userId,
      nextLocks,
      undefined,
      target.reason,
    );
    if (!updated.locked_reward_categories.includes("tips")) {
      throw new Error("Backend did not confirm the tips reward lock");
    }
  }

  await recordCriticalSignupContainmentAudit(target);
  return "locked";
}

/**
 * ADMIN-side record that an unattended system restricted this account.
 *
 * Filed under a dedicated automatic event type, never the staff vocabulary:
 * `antifraud_withdrawals_locked` is the Fraud workspace's operator trail
 * ("one row = one staff decision"), and `locked_withdrawals_*_enabled` is read
 * by this kind's own five-minute containment watchdog as a terminal staff
 * release — writing it here would stand that watchdog down permanently.
 *
 * De-duplicated on purpose. That same watchdog re-runs this apply for every
 * open critical case, so an unconditional write would add a row every five
 * minutes for as long as the case stays open. `admin_audit_events` has no
 * unique key and `createAdminAuditEvent` takes no idempotency key, so the
 * guard is an explicit existence check on (event type, account, reason); the
 * reason is derived from the signal, so a genuinely new critical signup still
 * gets its own row.
 *
 * Nothing in here may fail the containment: MAIN and the tip lock are already
 * applied, and a throw would have the outbox record `failed` and retry the
 * whole apply. The lookup is therefore caught, and the write itself uses the
 * durable path, which retries, falls back to `admin_audit_write_failures`,
 * alerts, and never throws.
 */
async function recordCriticalSignupContainmentAudit(
  target: CriticalSignupContainmentTarget,
): Promise<void> {
  try {
    const existing = await adminDrizzle.execute<{ id: string }>(sql`
      SELECT id
      FROM admin_audit_events
      WHERE event_type = 'antifraud_containment_locked'
        AND target_user_id = ${target.userId}
        AND metadata ->> 'reason' = ${target.reason}
      LIMIT 1
    `);
    if (existing.rows.length > 0) return;

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
        kind: "critical_risk_signup",
        // The signup score is carried inside `reason`; the raw signup evidence
        // stays in `antifraud_signals`.
        reason: target.reason,
        actions: CRITICAL_SIGNUP_ACTIONS,
      },
    });
  } catch (error) {
    logError(
      "antifraud.containment.criticalSignupAudit",
      "critical signup containment audit mirror failed",
      error,
    );
  }
}
