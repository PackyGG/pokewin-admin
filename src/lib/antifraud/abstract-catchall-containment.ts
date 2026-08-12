import "server-only";

import { sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import {
  createAdminAuditEvent,
  createAdminAuditEventDurable,
} from "@/lib/admin-audit";
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
    reason:
      `Automatic fraud lock: new catch-all email domain pending review (${domain})`.slice(
        0,
        500,
      ),
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
  const currentRewards = await getUserFeatureLocks(target.userId);
  const allRewards = currentRewards.available_reward_categories;
  if (allRewards.length === 0) {
    throw new Error("Backend exposes no reward-lock categories");
  }

  // Persist the complete before-state before touching MAIN or the backend.
  // A retry after a crash must never snapshot its own partially applied lock.
  if (signalRowId) {
    const prior = await adminDrizzle.execute<{ id: string }>(sql`
      SELECT id FROM admin_audit_events
      WHERE event_type IN (
          'antifraud_catchall_lock_snapshot',
          'antifraud_catchall_reward_lock_snapshot'
        )
        AND metadata ->> 'signalRowId' = ${signalRowId}
      LIMIT 1
    `);
    if (prior.rows.length === 0) {
      const main = await db.execute<{
        locked_deposits_fiat: string[];
        locked_deposits_at: Date | string | null;
        locked_deposits_by: string | null;
        locked_deposits_reason: string | null;
        locked_withdrawals_crypto: string[];
        locked_withdrawals_items: boolean;
        locked_withdrawals_at: Date | string | null;
        locked_withdrawals_by: string | null;
        locked_withdrawals_reason: string | null;
      }>(sql`
        SELECT
          locked_deposits_fiat, locked_deposits_at, locked_deposits_by,
          locked_deposits_reason, locked_withdrawals_crypto,
          locked_withdrawals_items, locked_withdrawals_at,
          locked_withdrawals_by, locked_withdrawals_reason
        FROM user_feature_locks
        WHERE user_id = ${target.userId}
        LIMIT 1
      `);
      const before = main.rows[0];
      await createAdminAuditEvent({
        adminUserId: null,
        eventType: "antifraud_catchall_lock_snapshot",
        targetUserId: target.userId,
        metadata: {
          source: "antifraud_containment",
          signalRowId,
          domain: target.domain,
          appliedReason: target.reason,
          previousCategories: currentRewards.locked_reward_categories,
          previousReason: currentRewards.locked_rewards_reason,
          previousMain: {
            existed: before !== undefined,
            depositsFiat: before?.locked_deposits_fiat ?? [],
            depositsAt: before?.locked_deposits_at ?? null,
            depositsBy: before?.locked_deposits_by ?? null,
            depositsReason: before?.locked_deposits_reason ?? null,
            withdrawalsCrypto: before?.locked_withdrawals_crypto ?? [],
            withdrawalsItems: before?.locked_withdrawals_items ?? false,
            withdrawalsAt: before?.locked_withdrawals_at ?? null,
            withdrawalsBy: before?.locked_withdrawals_by ?? null,
            withdrawalsReason: before?.locked_withdrawals_reason ?? null,
          },
        },
      });
    }
  }

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
      locked_deposits_at = EXCLUDED.locked_deposits_at,
      locked_deposits_by = NULL,
      locked_deposits_reason = EXCLUDED.locked_deposits_reason,
      locked_withdrawals_crypto = ARRAY['all']::text[],
      locked_withdrawals_items = TRUE,
      locked_withdrawals_at = EXCLUDED.locked_withdrawals_at,
      locked_withdrawals_by = NULL,
      locked_withdrawals_reason = EXCLUDED.locked_withdrawals_reason,
      updated_at = NOW()
    RETURNING user_id
  `);
  if (locked.rows.length === 0) return "skipped";

  const missing = allRewards.filter(
    (category) => !currentRewards.locked_reward_categories.includes(category),
  );
  if (
    missing.length > 0 ||
    currentRewards.locked_rewards_reason !== target.reason
  ) {
    const updated = await updateUserRewardLocks(
      target.userId,
      Array.from(
        new Set([...currentRewards.locked_reward_categories, ...allRewards]),
      ),
      undefined,
      target.reason,
    );
    if (
      allRewards.some(
        (category) => !updated.locked_reward_categories.includes(category),
      )
    ) {
      throw new Error("Backend did not confirm the full reward lock");
    }
  }

  await recordCatchallContainmentAudit(target, signalRowId);
  return "locked";
}

/**
 * ADMIN-side record that an unattended system restricted this account.
 *
 * The snapshot row above is the release path's before-state, written BEFORE
 * anything is touched — it proves what to restore, not that containment
 * happened. This row is the success record, written only once every leg
 * (MAIN + rewards) is confirmed, which is also why a retry after a partial
 * failure cannot leave a second copy behind.
 *
 * Filed under a dedicated automatic event type, never the staff vocabulary:
 * `antifraud_withdrawals_locked` is the Fraud workspace's operator trail
 * ("one row = one staff decision"), and `locked_withdrawals_*_enabled` is read
 * by the critical-signup watchdog as a terminal staff release.
 *
 * `createAdminAuditEventDurable` retries, falls back to
 * `admin_audit_write_failures`, alerts, and never throws — every lock is
 * already applied at this point, so a failed mirror must not turn an applied
 * containment into an outbox failure that retries the whole apply.
 */
async function recordCatchallContainmentAudit(
  target: AbstractCatchallContainmentTarget,
  signalRowId: string | undefined,
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
      kind: "abstract_email_catchall",
      signalRowId: signalRowId ?? null,
      // The DOMAIN only — the matched signal, never the address that carried
      // it. It is already the reason staff read on the account.
      domain: target.domain,
      reason: target.reason,
      lockedFiatDeposits: true,
      lockedWithdrawals: true,
      lockedRewardCategories: true,
    },
  });
}
