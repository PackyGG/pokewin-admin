import "server-only";

import { eq, sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { getPrimaryDrizzleDb, getReadDrizzleDb } from "@/lib/db";
import { user_kyc } from "@/lib/db-schema/main/schema";
import { logError } from "@/lib/errors/logger";
import {
  getUserFeatureLocks,
  updateUserRewardLocks,
} from "@/lib/backend-api/feature-locks";

/**
 * Ownership marker shared by every automatic lock written by the signed
 * Antifraud containment pipeline. A cleared Account Review may release these
 * locks; staff/manual locks use a different reason and must remain untouched.
 */
const AUTOMATIC_FRAUD_LOCK_REASON_PREFIX = "Automatic fraud lock: ";

const CRITICAL_SIGNUP_LOCK_REASON_PREFIX =
  `${AUTOMATIC_FRAUD_LOCK_REASON_PREFIX}critical signup scored `;

/**
 * WITHDRAWAL RELEASE — the account side of an Account Review verdict.
 *
 * Clearing a case used to be a note in the ADMIN DB and nothing else, so an
 * account auto-locked by ingest containment (or by the quick Lock withdrawals
 * command) stayed locked forever once the analyst decided it was fine: the
 * case left the queue, reminders stopped chasing it, and the lock survived
 * invisibly until someone happened to open /users/[id].
 *
 * A "cleared" verdict now means what it says — both withdrawal channels are
 * released in MAIN. Every flow that reaches the `cleared` status routes
 * through this one function so the behaviour cannot drift between the case
 * controls and the quick actions.
 *
 * Deliberate choices:
 *
 * - It NEVER throws. The verdict is already committed by the time this runs;
 *   a MAIN failure must not present a closed case as a failed action. The
 *   caller gets `failed` and tells the analyst to release it manually.
 * - It is idempotent. The UPDATE only matches a row that is actually locked,
 *   so a retry after a partial failure releases nothing twice and writes no
 *   duplicate audit rows.
 * - It releases antifraud-owned withdrawal locks and antifraud-owned Fiat
 *   deposit locks. Manual locks and opening/exchange/vault locks are separate
 *   decisions and are untouched.
 * - A KYC-gated account is NEVER released here. Requiring and reviewing KYC is
 *   owner/admin-only with fresh 2FA (`requireAntifraudManager` in
 *   `antifraud/kyc/actions.ts`); letting an analyst's case verdict lift that
 *   gate as a side effect would route around it. Such a case still clears —
 *   the withdrawals just stay locked until an owner or admin marks the
 *   verification cycle `safe`.
 *
 * The reverse is `restoreWithdrawalLocksForReopenedCase`: leaving `cleared`
 * puts the locks back, so the release lives exactly as long as the verdict
 * that justified it.
 */

export type WithdrawalReleaseOutcome =
  /** Locks were on and are now off. */
  | {
      status: "released";
      previousCrypto: string[];
      previousItems: boolean;
      releasedFiat: boolean;
      releasedTips: boolean;
    }
  /** Nothing to do — no lock row, or withdrawals were already open. */
  | { status: "already_open" }
  /** KYC is pending an owner/admin decision — only they may lift this. */
  | { status: "kyc_gated" }
  /** MAIN rejected the write. The verdict stands; the lock does too. */
  | { status: "failed" };

type ReleaseRow = {
  previous_crypto: string[] | null;
  previous_items: boolean | null;
  released_fiat: boolean;
  released_withdrawals: boolean;
};

/**
 * Release both withdrawal channels for `userId` and mirror it into the ADMIN
 * audit trail.
 *
 * The audit rows use the SAME event types as the /users feature-lock toggle
 * (`locked_withdrawals_*_disabled`), so the existing "staff checked" history
 * in the fiat workspace and the per-user audit view pick this up without a
 * second vocabulary. `antifraud_withdrawals_unlocked` is the Fraud-workspace
 * counterpart of `antifraud_withdrawals_locked`.
 */
export async function releaseWithdrawalLocksForClearedCase(params: {
  userId: string;
  adminUserId: string;
  reviewId: string;
  idempotencyKey?: string;
}): Promise<WithdrawalReleaseOutcome> {
  const { userId, adminUserId, reviewId, idempotencyKey } = params;

  // KYC gate first, and fail CLOSED: if we cannot prove the account is not
  // awaiting an owner/admin KYC decision, we do not touch the lock.
  try {
    const read = await getReadDrizzleDb();
    const [kyc] = await read
      .select({
        required: user_kyc.kyc_required,
        decision: user_kyc.admin_decision,
      })
      .from(user_kyc)
      .where(eq(user_kyc.user_id, userId))
      .limit(1);
    if (kyc?.required === true && kyc.decision !== "safe") {
      return { status: "kyc_gated" };
    }
  } catch (error) {
    logError(
      "antifraud.review.releaseWithdrawals",
      `KYC gate check failed for review ${reviewId}; leaving locks in place`,
      error,
    );
    return { status: "failed" };
  }

  let releasedTips = false;
  try {
    const current = await getUserFeatureLocks(userId);
    if (
      current.locked_reward_categories.includes("tips") &&
      current.locked_rewards_reason?.startsWith(
        CRITICAL_SIGNUP_LOCK_REASON_PREFIX,
      )
    ) {
      const next = current.locked_reward_categories.filter(
        (category) => category !== "tips",
      );
      const updated = await updateUserRewardLocks(
        userId,
        next,
        adminUserId,
        next.length > 0 ? current.locked_rewards_reason : null,
      );
      if (updated.locked_reward_categories.includes("tips")) {
        throw new Error("Backend did not confirm the tips unlock");
      }
      releasedTips = true;
    }
  } catch (error) {
    logError(
      "antifraud.review.releaseCriticalSignupTips",
      `tips release failed for review ${reviewId}`,
      error,
    );
    return { status: "failed" };
  }

  let row: ReleaseRow | undefined;
  try {
    const db = await getPrimaryDrizzleDb();
    // The CTE snapshots the pre-release state under a row lock, so the
    // returned "previous" values are the ones this call actually cleared and
    // two analysts clearing at once cannot both claim the release.
    const released = await db.execute<ReleaseRow>(sql`
      WITH previous AS (
        SELECT
          user_id,
          locked_deposits_crypto AS deposits_crypto,
          locked_deposits_fiat AS deposits_fiat,
          locked_deposits_reason AS deposits_reason,
          locked_withdrawals_crypto AS crypto,
          locked_withdrawals_items AS items,
          locked_withdrawals_reason AS withdrawals_reason
        FROM user_feature_locks
        WHERE user_id = ${userId}
        FOR UPDATE
      )
      UPDATE user_feature_locks AS locks
      SET
        locked_deposits_fiat = CASE
          WHEN previous.deposits_reason LIKE ${AUTOMATIC_FRAUD_LOCK_REASON_PREFIX + "%"}
            THEN '{}'::text[]
          ELSE locks.locked_deposits_fiat
        END,
        locked_deposits_at = CASE
          WHEN previous.deposits_reason LIKE ${AUTOMATIC_FRAUD_LOCK_REASON_PREFIX + "%"}
            AND COALESCE(array_length(previous.deposits_crypto, 1), 0) = 0
            THEN NULL
          ELSE locks.locked_deposits_at
        END,
        locked_deposits_by = CASE
          WHEN previous.deposits_reason LIKE ${AUTOMATIC_FRAUD_LOCK_REASON_PREFIX + "%"}
            AND COALESCE(array_length(previous.deposits_crypto, 1), 0) = 0
            THEN NULL
          ELSE locks.locked_deposits_by
        END,
        locked_deposits_reason = CASE
          WHEN previous.deposits_reason LIKE ${AUTOMATIC_FRAUD_LOCK_REASON_PREFIX + "%"}
            AND COALESCE(array_length(previous.deposits_crypto, 1), 0) = 0
            THEN NULL
          ELSE locks.locked_deposits_reason
        END,
        locked_withdrawals_crypto = CASE
          WHEN previous.withdrawals_reason LIKE ${AUTOMATIC_FRAUD_LOCK_REASON_PREFIX + "%"}
            THEN '{}'::text[]
          ELSE locks.locked_withdrawals_crypto
        END,
        locked_withdrawals_items = CASE
          WHEN previous.withdrawals_reason LIKE ${AUTOMATIC_FRAUD_LOCK_REASON_PREFIX + "%"}
            THEN FALSE
          ELSE locks.locked_withdrawals_items
        END,
        locked_withdrawals_at = CASE
          WHEN previous.withdrawals_reason LIKE ${AUTOMATIC_FRAUD_LOCK_REASON_PREFIX + "%"}
            THEN NULL
          ELSE locks.locked_withdrawals_at
        END,
        locked_withdrawals_by = CASE
          WHEN previous.withdrawals_reason LIKE ${AUTOMATIC_FRAUD_LOCK_REASON_PREFIX + "%"}
            THEN NULL
          ELSE locks.locked_withdrawals_by
        END,
        locked_withdrawals_reason = CASE
          WHEN previous.withdrawals_reason LIKE ${AUTOMATIC_FRAUD_LOCK_REASON_PREFIX + "%"}
            THEN NULL
          ELSE locks.locked_withdrawals_reason
        END,
        updated_at = NOW()
      FROM previous
      WHERE locks.user_id = previous.user_id
        AND (
          (
            previous.deposits_reason LIKE ${AUTOMATIC_FRAUD_LOCK_REASON_PREFIX + "%"}
            AND COALESCE(array_length(previous.deposits_fiat, 1), 0) > 0
          ) OR (
            previous.withdrawals_reason LIKE ${AUTOMATIC_FRAUD_LOCK_REASON_PREFIX + "%"}
            AND (
              COALESCE(array_length(previous.crypto, 1), 0) > 0
              OR previous.items
            )
          )
        )
      RETURNING
        previous.crypto AS previous_crypto,
        previous.items AS previous_items,
        (
          previous.deposits_reason LIKE ${AUTOMATIC_FRAUD_LOCK_REASON_PREFIX + "%"}
          AND COALESCE(array_length(previous.deposits_fiat, 1), 0) > 0
        ) AS released_fiat,
        (
          previous.withdrawals_reason LIKE ${AUTOMATIC_FRAUD_LOCK_REASON_PREFIX + "%"}
          AND (
            COALESCE(array_length(previous.crypto, 1), 0) > 0
            OR previous.items
          )
        ) AS released_withdrawals
    `);
    row = released.rows[0];
  } catch (error) {
    logError(
      "antifraud.review.releaseWithdrawals",
      `withdrawal release failed for review ${reviewId}`,
      error,
    );
    return { status: "failed" };
  }

  if (!row && !releasedTips) return { status: "already_open" };

  const previousCrypto = row?.previous_crypto ?? [];
  const previousItems = row?.previous_items === true;
  const releasedFiat = row?.released_fiat === true;
  const releasedWithdrawals = row?.released_withdrawals === true;
  const metadata = {
    source: "antifraud_review",
    reviewId,
    idempotencyKey,
    previousCrypto,
    previousItems,
    releasedFiat,
    releasedTips,
  };

  // Best effort: MAIN is already released. A failed mirror must not report the
  // release as failed — that would push the analyst into unlocking an account
  // that is already unlocked.
  try {
    await createAdminAuditEvent({
      adminUserId,
      eventType: "antifraud_critical_signup_restrictions_unlocked",
      targetUserId: userId,
      metadata,
    });
    // Both channels are open after this write, so both canonical toggles are
    // recorded — the staff-checked derivation needs the pair, not just the
    // channel that happened to be locked.
    if (releasedWithdrawals) {
      await createAdminAuditEvent({
        adminUserId,
        eventType: "antifraud_withdrawals_unlocked",
        targetUserId: userId,
        metadata,
      });
      await createAdminAuditEvent({
        adminUserId,
        eventType: "locked_withdrawals_crypto_disabled",
        targetUserId: userId,
        metadata: { ...metadata, feature: "locked_withdrawals_crypto", locked: false },
      });
      await createAdminAuditEvent({
        adminUserId,
        eventType: "locked_withdrawals_items_disabled",
        targetUserId: userId,
        metadata: { ...metadata, feature: "locked_withdrawals_items", locked: false },
      });
    }
  } catch (error) {
    logError(
      "antifraud.review.releaseWithdrawals",
      `withdrawal release audit mirror failed for review ${reviewId}`,
      error,
    );
  }

  return {
    status: "released",
    previousCrypto,
    previousItems,
    releasedFiat,
    releasedTips,
  };
}

export type WithdrawalRestoreOutcome =
  /** Locks are back on. */
  | { status: "relocked" }
  /** This case's clear never released anything, so there is nothing to undo. */
  | { status: "nothing_to_restore" }
  /** MAIN rejected the write. The case is reopened but the account is open. */
  | { status: "failed" };

/**
 * Put back what a cleared verdict released.
 *
 * Leaving `cleared` — reopening the case, sending it back to review, or
 * flagging it — withdraws the verdict, so the account consequence has to go
 * with it. Otherwise a cleared-then-reopened account keeps withdrawing while
 * staff are still deciding, which is the exact window this whole workspace
 * exists to close.
 *
 * It re-locks ONLY when this case's own clear did the releasing, proven by an
 * `antifraud_withdrawals_unlocked` audit row carrying this `reviewId`. Without
 * that check, reopening a case on an account that was never locked in the
 * first place would lock it — inventing a restriction instead of restoring
 * one. Same contract as the release: never throws, safe to re-run.
 */
export async function restoreWithdrawalLocksForReopenedCase(params: {
  userId: string;
  adminUserId: string;
  reviewId: string;
  idempotencyKey?: string;
}): Promise<WithdrawalRestoreOutcome> {
  const { userId, adminUserId, reviewId, idempotencyKey } = params;

  try {
    const released = await adminDrizzle.execute<{ id: string }>(sql`
      SELECT id
      FROM admin_audit_events
      WHERE event_type = 'antifraud_withdrawals_unlocked'
        AND target_user_id = ${userId}
        AND metadata ->> 'reviewId' = ${reviewId}
      LIMIT 1
    `);
    if (released.rows.length === 0) return { status: "nothing_to_restore" };
  } catch (error) {
    logError(
      "antifraud.review.restoreWithdrawals",
      `release-history lookup failed for review ${reviewId}`,
      error,
    );
    return { status: "failed" };
  }

  const reason = `Antifraud review ${reviewId} reopened`;
  try {
    const db = await getPrimaryDrizzleDb();
    const locked = await db.execute<{ user_id: string }>(sql`
      INSERT INTO user_feature_locks (
        id,
        user_id,
        locked_withdrawals_crypto,
        locked_withdrawals_items,
        locked_withdrawals_at,
        locked_withdrawals_by,
        locked_withdrawals_reason,
        created_at,
        updated_at
      )
      SELECT
        ${crypto.randomUUID()},
        u.id,
        ARRAY['all']::text[],
        TRUE,
        NOW(),
        NULL,
        ${reason},
        NOW(),
        NOW()
      FROM "user" u
      WHERE u.id = ${userId}
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
    if (locked.rows.length === 0) return { status: "nothing_to_restore" };
  } catch (error) {
    logError(
      "antifraud.review.restoreWithdrawals",
      `withdrawal re-lock failed for review ${reviewId}`,
      error,
    );
    return { status: "failed" };
  }

  const metadata = {
    source: "antifraud_review",
    reviewId,
    idempotencyKey,
    reason,
    crypto: "all",
    items: true,
  };
  // Best effort, same as the release: MAIN is already locked.
  try {
    await createAdminAuditEvent({
      adminUserId,
      eventType: "antifraud_withdrawals_locked",
      targetUserId: userId,
      metadata,
    });
    await createAdminAuditEvent({
      adminUserId,
      eventType: "locked_withdrawals_crypto_enabled",
      targetUserId: userId,
      metadata: { ...metadata, feature: "locked_withdrawals_crypto", locked: true },
    });
    await createAdminAuditEvent({
      adminUserId,
      eventType: "locked_withdrawals_items_enabled",
      targetUserId: userId,
      metadata: { ...metadata, feature: "locked_withdrawals_items", locked: true },
    });
  } catch (error) {
    logError(
      "antifraud.review.restoreWithdrawals",
      `withdrawal re-lock audit mirror failed for review ${reviewId}`,
      error,
    );
  }

  return { status: "relocked" };
}
