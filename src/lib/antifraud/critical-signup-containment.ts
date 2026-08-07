import "server-only";

import { sql } from "drizzle-orm";

import {
  getUserFeatureLocks,
  updateUserRewardLocks,
  type RewardLockCategory,
} from "@/lib/backend-api/feature-locks";
import { getProdPrimaryDrizzleDb } from "@/lib/db";

/**
 * Critical signup containment: Fiat deposits + withdrawals in MAIN, then tip
 * lock via the backend reward-lock API. Never mutates KYC.
 */

const CRITICAL_SIGNUP_ACTIONS = [
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
  return "locked";
}
