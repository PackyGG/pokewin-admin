import "server-only";

import { eq, sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { getPrimaryDrizzleDb, getReadDrizzleDb } from "@/lib/db";
import { user_kyc } from "@/lib/db-schema/main/schema";
import { logError } from "@/lib/errors/logger";
import { pgArrayParam } from "@/lib/drizzle-array-param";
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

/**
 * EVERY reason prefix the automatic containment pipeline writes. Release has to
 * match all of them, not just the one it happens to write itself.
 *
 * `email-domain-containment.ts` writes its blocked-domain variant as
 * "Automatic fraud ban: …" and stores that straight into
 * `locked_withdrawals_reason` / `locked_deposits_reason`. Because release only
 * compared the "Automatic fraud lock: " literal, those locks were invisible to
 * it: clearing the case reported "review locks removed" while the account
 * stayed fiat- and withdrawal-locked permanently, with nothing left in the
 * queue to reveal it.
 *
 * Widening this list only ever releases reasons the pipeline itself authored.
 * Staff and manual locks use different reason text and remain untouched, which
 * is the property that makes automatic release safe in the first place.
 */
const AUTOMATIC_FRAUD_LOCK_REASON_PREFIXES = [
  AUTOMATIC_FRAUD_LOCK_REASON_PREFIX,
  "Automatic fraud ban: ",
] as const;

/** True when `reason` was authored by the automatic containment pipeline. */
function isAutomaticFraudLockReason(reason: string | null | undefined): boolean {
  return (
    typeof reason === "string" &&
    AUTOMATIC_FRAUD_LOCK_REASON_PREFIXES.some((prefix) =>
      reason.startsWith(prefix),
    )
  );
}

/**
 * `LIKE ANY (...)` patterns for the same set. Bound through `pgArrayParam` as a
 * single `text[]` parameter — the house rule for array binding, since a bare
 * array in a tagged template expands to `($1, $2, …)` rather than one array.
 */
const AUTOMATIC_FRAUD_LOCK_REASON_PATTERNS = AUTOMATIC_FRAUD_LOCK_REASON_PREFIXES
  .map((prefix) => `${prefix}%`);

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
      releasedRewardCategories: string[];
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

type CatchallMainSnapshot = {
  appliedReason: string;
  depositsFiat: string[];
  depositsAt: string | null;
  depositsBy: string | null;
  depositsReason: string | null;
  withdrawalsCrypto: string[];
  withdrawalsItems: boolean;
  withdrawalsAt: string | null;
  withdrawalsBy: string | null;
  withdrawalsReason: string | null;
};

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function catchallMainSnapshot(
  metadata: Record<string, unknown> | undefined,
): CatchallMainSnapshot | null {
  const raw = metadata?.previousMain;
  const appliedReason = metadata?.appliedReason;
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    typeof appliedReason !== "string"
  ) {
    return null;
  }
  const value = raw as Record<string, unknown>;
  return {
    appliedReason,
    depositsFiat: stringArray(value.depositsFiat),
    depositsAt: nullableString(value.depositsAt),
    depositsBy: nullableString(value.depositsBy),
    depositsReason: nullableString(value.depositsReason),
    withdrawalsCrypto: stringArray(value.withdrawalsCrypto),
    withdrawalsItems: value.withdrawalsItems === true,
    withdrawalsAt: nullableString(value.withdrawalsAt),
    withdrawalsBy: nullableString(value.withdrawalsBy),
    withdrawalsReason: nullableString(value.withdrawalsReason),
  };
}

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

  let catchallSnapshot: Record<string, unknown> | undefined;
  try {
    const snapshot = await adminDrizzle.execute<{
      metadata: Record<string, unknown>;
    }>(sql`
      SELECT audit.metadata
      FROM antifraud_signals AS signal
      JOIN admin_audit_events AS audit
        ON audit.event_type IN (
            'antifraud_catchall_lock_snapshot',
            'antifraud_catchall_reward_lock_snapshot'
          )
       AND audit.metadata ->> 'signalRowId' = signal.id::text
      WHERE signal.review_id = ${reviewId}::uuid
        AND signal.kind = 'abstract_email_catchall'
        AND audit.target_user_id = ${userId}
      ORDER BY audit.created_at DESC
      LIMIT 1
    `);
    catchallSnapshot = snapshot.rows[0]?.metadata;
  } catch (error) {
    logError(
      "antifraud.review.releaseAutomaticRestrictions",
      `catch-all snapshot lookup failed for review ${reviewId}`,
      error,
    );
    return { status: "failed" };
  }

  let releasedRewardCategories: string[] = [];
  try {
    const current = await getUserFeatureLocks(userId);
    if (
      current.locked_reward_categories.length > 0 &&
      isAutomaticFraudLockReason(current.locked_rewards_reason)
    ) {
      const previousCategories = Array.isArray(
        catchallSnapshot?.previousCategories,
      )
        ? catchallSnapshot.previousCategories.filter(
            (
              value,
            ): value is (typeof current.locked_reward_categories)[number] =>
              typeof value === "string" &&
              current.available_reward_categories.includes(
                value as (typeof current.locked_reward_categories)[number],
              ),
          )
        : [];
      const previousReason =
        typeof catchallSnapshot?.previousReason === "string"
          ? catchallSnapshot.previousReason
          : null;
      const updated = await updateUserRewardLocks(
        userId,
        previousCategories,
        adminUserId,
        previousReason,
      );
      if (
        updated.locked_reward_categories.length !== previousCategories.length ||
        previousCategories.some(
          (category) => !updated.locked_reward_categories.includes(category),
        )
      ) {
        throw new Error("Backend did not confirm the reward unlock");
      }
      releasedRewardCategories = current.locked_reward_categories.filter(
        (category) => !previousCategories.includes(category),
      );
    }
  } catch (error) {
    logError(
      "antifraud.review.releaseAutomaticRewards",
      `reward release failed for review ${reviewId}`,
      error,
    );
    return { status: "failed" };
  }

  let row: ReleaseRow | undefined;
  let restoredCatchallReason: string | null = null;
  try {
    const db = await getPrimaryDrizzleDb();
    const savedMain = catchallMainSnapshot(catchallSnapshot);
    if (savedMain) {
      restoredCatchallReason = savedMain.appliedReason;
      const restored = await db.execute<ReleaseRow>(sql`
        WITH previous AS (
          SELECT
            user_id,
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
            WHEN previous.deposits_reason = ${savedMain.appliedReason}
              THEN ${pgArrayParam(savedMain.depositsFiat)}::text[]
            ELSE locks.locked_deposits_fiat END,
          locked_deposits_at = CASE
            WHEN previous.deposits_reason = ${savedMain.appliedReason}
              THEN ${savedMain.depositsAt}::timestamp
            ELSE locks.locked_deposits_at END,
          locked_deposits_by = CASE
            WHEN previous.deposits_reason = ${savedMain.appliedReason}
              THEN ${savedMain.depositsBy}
            ELSE locks.locked_deposits_by END,
          locked_deposits_reason = CASE
            WHEN previous.deposits_reason = ${savedMain.appliedReason}
              THEN ${savedMain.depositsReason}
            ELSE locks.locked_deposits_reason END,
          locked_withdrawals_crypto = CASE
            WHEN previous.withdrawals_reason = ${savedMain.appliedReason}
              THEN ${pgArrayParam(savedMain.withdrawalsCrypto)}::text[]
            ELSE locks.locked_withdrawals_crypto END,
          locked_withdrawals_items = CASE
            WHEN previous.withdrawals_reason = ${savedMain.appliedReason}
              THEN ${savedMain.withdrawalsItems}
            ELSE locks.locked_withdrawals_items END,
          locked_withdrawals_at = CASE
            WHEN previous.withdrawals_reason = ${savedMain.appliedReason}
              THEN ${savedMain.withdrawalsAt}::timestamp
            ELSE locks.locked_withdrawals_at END,
          locked_withdrawals_by = CASE
            WHEN previous.withdrawals_reason = ${savedMain.appliedReason}
              THEN ${savedMain.withdrawalsBy}
            ELSE locks.locked_withdrawals_by END,
          locked_withdrawals_reason = CASE
            WHEN previous.withdrawals_reason = ${savedMain.appliedReason}
              THEN ${savedMain.withdrawalsReason}
            ELSE locks.locked_withdrawals_reason END,
          updated_at = NOW()
        FROM previous
        WHERE locks.user_id = previous.user_id
          AND (
            previous.deposits_reason = ${savedMain.appliedReason}
            OR previous.withdrawals_reason = ${savedMain.appliedReason}
          )
        RETURNING
          previous.crypto AS previous_crypto,
          previous.items AS previous_items,
          (
            previous.deposits_reason = ${savedMain.appliedReason}
            AND previous.deposits_fiat IS DISTINCT FROM
              ${pgArrayParam(savedMain.depositsFiat)}::text[]
          ) AS released_fiat,
          (
            previous.withdrawals_reason = ${savedMain.appliedReason}
            AND (
              previous.crypto IS DISTINCT FROM
                ${pgArrayParam(savedMain.withdrawalsCrypto)}::text[]
              OR previous.items IS DISTINCT FROM ${savedMain.withdrawalsItems}
            )
          ) AS released_withdrawals
      `);
      row = restored.rows[0];
    } else {
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
          WHEN previous.deposits_reason LIKE ANY (${pgArrayParam(AUTOMATIC_FRAUD_LOCK_REASON_PATTERNS)}::text[])
            THEN '{}'::text[]
          ELSE locks.locked_deposits_fiat
        END,
        locked_deposits_at = CASE
          WHEN previous.deposits_reason LIKE ANY (${pgArrayParam(AUTOMATIC_FRAUD_LOCK_REASON_PATTERNS)}::text[])
            AND COALESCE(array_length(previous.deposits_crypto, 1), 0) = 0
            THEN NULL
          ELSE locks.locked_deposits_at
        END,
        locked_deposits_by = CASE
          WHEN previous.deposits_reason LIKE ANY (${pgArrayParam(AUTOMATIC_FRAUD_LOCK_REASON_PATTERNS)}::text[])
            AND COALESCE(array_length(previous.deposits_crypto, 1), 0) = 0
            THEN NULL
          ELSE locks.locked_deposits_by
        END,
        locked_deposits_reason = CASE
          WHEN previous.deposits_reason LIKE ANY (${pgArrayParam(AUTOMATIC_FRAUD_LOCK_REASON_PATTERNS)}::text[])
            AND COALESCE(array_length(previous.deposits_crypto, 1), 0) = 0
            THEN NULL
          ELSE locks.locked_deposits_reason
        END,
        locked_withdrawals_crypto = CASE
          WHEN previous.withdrawals_reason LIKE ANY (${pgArrayParam(AUTOMATIC_FRAUD_LOCK_REASON_PATTERNS)}::text[])
            THEN '{}'::text[]
          ELSE locks.locked_withdrawals_crypto
        END,
        locked_withdrawals_items = CASE
          WHEN previous.withdrawals_reason LIKE ANY (${pgArrayParam(AUTOMATIC_FRAUD_LOCK_REASON_PATTERNS)}::text[])
            THEN FALSE
          ELSE locks.locked_withdrawals_items
        END,
        locked_withdrawals_at = CASE
          WHEN previous.withdrawals_reason LIKE ANY (${pgArrayParam(AUTOMATIC_FRAUD_LOCK_REASON_PATTERNS)}::text[])
            THEN NULL
          ELSE locks.locked_withdrawals_at
        END,
        locked_withdrawals_by = CASE
          WHEN previous.withdrawals_reason LIKE ANY (${pgArrayParam(AUTOMATIC_FRAUD_LOCK_REASON_PATTERNS)}::text[])
            THEN NULL
          ELSE locks.locked_withdrawals_by
        END,
        locked_withdrawals_reason = CASE
          WHEN previous.withdrawals_reason LIKE ANY (${pgArrayParam(AUTOMATIC_FRAUD_LOCK_REASON_PATTERNS)}::text[])
            THEN NULL
          ELSE locks.locked_withdrawals_reason
        END,
        updated_at = NOW()
      FROM previous
      WHERE locks.user_id = previous.user_id
        AND (
          (
            previous.deposits_reason LIKE ANY (${pgArrayParam(AUTOMATIC_FRAUD_LOCK_REASON_PATTERNS)}::text[])
            AND COALESCE(array_length(previous.deposits_fiat, 1), 0) > 0
          ) OR (
            previous.withdrawals_reason LIKE ANY (${pgArrayParam(AUTOMATIC_FRAUD_LOCK_REASON_PATTERNS)}::text[])
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
          previous.deposits_reason LIKE ANY (${pgArrayParam(AUTOMATIC_FRAUD_LOCK_REASON_PATTERNS)}::text[])
          AND COALESCE(array_length(previous.deposits_fiat, 1), 0) > 0
        ) AS released_fiat,
        (
          previous.withdrawals_reason LIKE ANY (${pgArrayParam(AUTOMATIC_FRAUD_LOCK_REASON_PATTERNS)}::text[])
          AND (
            COALESCE(array_length(previous.crypto, 1), 0) > 0
            OR previous.items
          )
        ) AS released_withdrawals
    `);
      row = released.rows[0];
    }
  } catch (error) {
    logError(
      "antifraud.review.releaseWithdrawals",
      `withdrawal release failed for review ${reviewId}`,
      error,
    );
    return { status: "failed" };
  }

  if (!row && releasedRewardCategories.length === 0)
    return { status: "already_open" };

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
    releasedWithdrawals,
    releasedRewardCategories,
    catchallAppliedReason: restoredCatchallReason,
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
        metadata: {
          ...metadata,
          feature: "locked_withdrawals_crypto",
          locked: false,
        },
      });
      await createAdminAuditEvent({
        adminUserId,
        eventType: "locked_withdrawals_items_disabled",
        targetUserId: userId,
        metadata: {
          ...metadata,
          feature: "locked_withdrawals_items",
          locked: false,
        },
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
    releasedRewardCategories,
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
 * It re-locks ONLY when this case's own clear did the releasing, proven by the
 * combined restriction-release audit row carrying this `reviewId`. Without
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

  let releaseMetadata: Record<string, unknown>;
  try {
    const released = await adminDrizzle.execute<{
      metadata: Record<string, unknown>;
    }>(sql`
      SELECT metadata
      FROM admin_audit_events
      WHERE event_type = 'antifraud_critical_signup_restrictions_unlocked'
        AND target_user_id = ${userId}
        AND metadata ->> 'reviewId' = ${reviewId}
      ORDER BY created_at DESC
      LIMIT 1
    `);
    if (released.rows.length === 0) return { status: "nothing_to_restore" };
    releaseMetadata = released.rows[0]?.metadata ?? {};
  } catch (error) {
    logError(
      "antifraud.review.restoreWithdrawals",
      `release-history lookup failed for review ${reviewId}`,
      error,
    );
    return { status: "failed" };
  }

  const reason =
    typeof releaseMetadata.catchallAppliedReason === "string"
      ? releaseMetadata.catchallAppliedReason
      : `${AUTOMATIC_FRAUD_LOCK_REASON_PREFIX}antifraud review ${reviewId} reopened`;
  const restoreExactCatchall =
    typeof releaseMetadata.catchallAppliedReason === "string";
  const restoreFiat = releaseMetadata.releasedFiat === true;
  const restoreWithdrawals = releaseMetadata.releasedWithdrawals === true;
  try {
    const db = await getPrimaryDrizzleDb();
    const locked = await db.execute<{ user_id: string }>(sql`
      INSERT INTO user_feature_locks (
        id,
        user_id,
        locked_deposits_fiat,
        locked_deposits_at,
        locked_deposits_by,
        locked_deposits_reason,
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
        CASE WHEN ${restoreFiat} THEN ARRAY['all']::text[] ELSE '{}'::text[] END,
        CASE WHEN ${restoreFiat} THEN NOW() ELSE NULL END,
        NULL,
        CASE WHEN ${restoreFiat} THEN ${reason} ELSE NULL END,
        CASE WHEN ${restoreWithdrawals} THEN ARRAY['all']::text[] ELSE '{}'::text[] END,
        ${restoreWithdrawals},
        CASE WHEN ${restoreWithdrawals} THEN NOW() ELSE NULL END,
        NULL,
        CASE WHEN ${restoreWithdrawals} THEN ${reason} ELSE NULL END,
        NOW(),
        NOW()
      FROM "user" u
      WHERE u.id = ${userId}
      ON CONFLICT (user_id) DO UPDATE SET
        locked_deposits_fiat = CASE WHEN ${restoreFiat}
          THEN ARRAY['all']::text[] ELSE user_feature_locks.locked_deposits_fiat END,
        locked_deposits_at = CASE WHEN ${restoreFiat}
          THEN CASE WHEN ${restoreExactCatchall} THEN NOW()
            ELSE COALESCE(user_feature_locks.locked_deposits_at, NOW()) END
          ELSE user_feature_locks.locked_deposits_at END,
        locked_deposits_reason = CASE WHEN ${restoreFiat}
          THEN CASE WHEN ${restoreExactCatchall} THEN ${reason}
            ELSE COALESCE(user_feature_locks.locked_deposits_reason, ${reason}) END
          ELSE user_feature_locks.locked_deposits_reason END,
        locked_withdrawals_crypto = CASE WHEN ${restoreWithdrawals}
          THEN ARRAY['all']::text[] ELSE user_feature_locks.locked_withdrawals_crypto END,
        locked_withdrawals_items = CASE WHEN ${restoreWithdrawals}
          THEN TRUE ELSE user_feature_locks.locked_withdrawals_items END,
        locked_withdrawals_at = CASE WHEN ${restoreWithdrawals}
          THEN CASE WHEN ${restoreExactCatchall} THEN NOW()
            ELSE COALESCE(user_feature_locks.locked_withdrawals_at, EXCLUDED.locked_withdrawals_at) END
          ELSE user_feature_locks.locked_withdrawals_at END,
        locked_withdrawals_reason = CASE WHEN ${restoreWithdrawals}
          THEN CASE WHEN ${restoreExactCatchall} THEN ${reason}
            ELSE COALESCE(user_feature_locks.locked_withdrawals_reason, EXCLUDED.locked_withdrawals_reason) END
          ELSE user_feature_locks.locked_withdrawals_reason END,
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

  const releasedRewards = Array.isArray(
    releaseMetadata.releasedRewardCategories,
  )
    ? releaseMetadata.releasedRewardCategories.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  if (releasedRewards.length > 0) {
    try {
      const current = await getUserFeatureLocks(userId);
      const restorable = releasedRewards.filter((category) =>
        current.available_reward_categories.includes(
          category as (typeof current.available_reward_categories)[number],
        ),
      ) as typeof current.available_reward_categories;
      const updated = await updateUserRewardLocks(
        userId,
        Array.from(
          new Set([...current.locked_reward_categories, ...restorable]),
        ),
        adminUserId,
        reason,
      );
      if (
        restorable.some(
          (category) => !updated.locked_reward_categories.includes(category),
        )
      ) {
        throw new Error("Backend did not confirm the restored reward locks");
      }
    } catch (error) {
      logError(
        "antifraud.review.restoreRewards",
        `reward re-lock failed for review ${reviewId}`,
        error,
      );
      return { status: "failed" };
    }
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
      metadata: {
        ...metadata,
        feature: "locked_withdrawals_crypto",
        locked: true,
      },
    });
    await createAdminAuditEvent({
      adminUserId,
      eventType: "locked_withdrawals_items_enabled",
      targetUserId: userId,
      metadata: {
        ...metadata,
        feature: "locked_withdrawals_items",
        locked: true,
      },
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
