import "server-only";

import { sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  getUserFeatureLocks,
  updateUserRewardLocks,
} from "@/lib/backend-api/feature-locks";
import { getProdPrimaryDrizzleDb } from "@/lib/db";

/**
 * Full temporary containment for a newly discovered Abstract-confirmed
 * catch-all signup domain. Known blocked domains use email-domain containment
 * and are banned; a first-seen domain stays reviewable. Never mutates KYC.
 *
 * Pure target + MAIN apply split so admission runs inside the ADMIN ingest
 * transaction and the lock runs only after commit via the outbox.
 */

export type AbstractCatchallContainmentTarget = {
  userId: string;
  domain: string;
  reason: string;
};

function normalizedDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const domain = value.trim().toLowerCase();
  return /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(domain) &&
    domain.includes(".")
    ? domain
    : null;
}

/**
 * Pure admission check — safe inside the ADMIN ingest transaction.
 */
export function abstractCatchallContainmentTarget(signal: {
  userId?: string | null;
  payload?: Record<string, unknown> | null;
}): AbstractCatchallContainmentTarget | null {
  const userId = signal.userId;
  const domain = normalizedDomain(signal.payload?.emailDomain);
  if (
    !userId ||
    !domain ||
    signal.payload?.containmentRequired !== true ||
    signal.payload?.provider !== "abstract_email"
  ) {
    return null;
  }

  return {
    userId,
    domain,
    reason: (
      `Automatic fraud lock: new catch-all email domain pending review (${domain})`
    ).slice(0, 500),
  };
}

/**
 * Lock Fiat deposits, both withdrawal channels, and every reward category the
 * backend exposes. The MAIN leg is idempotent and the reward leg is verified,
 * so a partial failure remains retryable through the containment outbox.
 */
export async function applyAbstractCatchallContainment(
  target: AbstractCatchallContainmentTarget,
  signalRowId?: string,
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
      locked_deposits_at = COALESCE(user_feature_locks.locked_deposits_at, EXCLUDED.locked_deposits_at),
      locked_deposits_reason = COALESCE(user_feature_locks.locked_deposits_reason, EXCLUDED.locked_deposits_reason),
      locked_withdrawals_crypto = ARRAY['all']::text[],
      locked_withdrawals_items = TRUE,
      locked_withdrawals_at = COALESCE(user_feature_locks.locked_withdrawals_at, EXCLUDED.locked_withdrawals_at),
      locked_withdrawals_reason = COALESCE(user_feature_locks.locked_withdrawals_reason, EXCLUDED.locked_withdrawals_reason),
      updated_at = NOW()
    RETURNING user_id
  `);
  if (locked.rows.length === 0) return "skipped";

  const current = await getUserFeatureLocks(target.userId);
  const allRewards = current.available_reward_categories;
  if (allRewards.length === 0) {
    throw new Error("Backend exposes no reward-lock categories");
  }
  if (signalRowId) {
    const prior = await adminDrizzle.execute<{ id: string }>(sql`
      SELECT id FROM admin_audit_events
      WHERE event_type = 'antifraud_catchall_reward_lock_snapshot'
        AND metadata ->> 'signalRowId' = ${signalRowId}
      LIMIT 1
    `);
    if (prior.rows.length === 0) {
      await createAdminAuditEvent({
        adminUserId: null,
        eventType: "antifraud_catchall_reward_lock_snapshot",
        targetUserId: target.userId,
        metadata: {
          source: "antifraud_containment",
          signalRowId,
          domain: target.domain,
          previousCategories: current.locked_reward_categories,
          previousReason: current.locked_rewards_reason,
        },
      });
    }
  }
  const missing = allRewards.filter(
    (category) => !current.locked_reward_categories.includes(category),
  );
  if (missing.length > 0) {
    const updated = await updateUserRewardLocks(
      target.userId,
      Array.from(new Set([...current.locked_reward_categories, ...allRewards])),
      undefined,
      target.reason,
    );
    if (allRewards.some((category) => !updated.locked_reward_categories.includes(category))) {
      throw new Error("Backend did not confirm the full reward lock");
    }
  }
  return "locked";
}
