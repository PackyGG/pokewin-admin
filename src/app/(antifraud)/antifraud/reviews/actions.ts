"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import { and, eq, inArray, ne, sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  admin_audit_events,
  admin_users,
  antifraud_review_notes,
  antifraud_reviews,
  staff_profiles,
} from "@/lib/db-schema/admin/schema";
import { requireAntifraudAccess } from "@/lib/require-antifraud-access";
import { require2FA } from "@/lib/require-2fa";
import { requireCapability } from "@/lib/require-capability";
import { getPrimaryDrizzleDb } from "@/lib/db";
import { resolveAdminMainUserId } from "@/lib/resolve-admin-main-user-id";
import { userDetailTag } from "@/lib/queries/users-detail-cache";
import { isPostgresError } from "@/lib/postgres-errors";
import {
  REVIEW_STATUSES,
  REVIEW_STATUS_LABELS,
} from "@/lib/antifraud/reviews";
import {
  getAntifraudAccessSettings,
  getAntifraudUserAccess,
} from "@/lib/antifraud/access";
import { isAssignableAnalyst } from "@/lib/antifraud/review-analysts";
import { releaseWithdrawalLocksForClearedCase } from "@/lib/antifraud/withdrawal-release";
import { REVIEW_REMINDER_DELAYS_MS } from "@/lib/discord-notifications/antifraud-policy";

/**
 * Account-review mutations.
 *
 * Most actions only touch the ADMIN review record. The explicit quick Ban and
 * Lock withdrawals commands use the established MAIN mutation client, require
 * the matching capability, and write the normal admin audit trail. Clearing a
 * case additionally RELEASES the player's withdrawal locks — see
 * `releaseClearedCaseWithdrawals` below.
 *
 * Every action re-verifies workspace access (server actions run as their own
 * request), validates with Zod, writes an append-only note describing the
 * change, and mirrors the important ones into `admin_audit_events` so the
 * existing audit viewer sees them too.
 */

const uuid = z.string().uuid("Invalid id");

/**
 * The statuses covered by the `antifraud_reviews_open_target_uniq` partial
 * unique index — ONE live case per player. Deliberately NOT
 * `OPEN_REVIEW_STATUSES` (which describes the queue's "needs work" filter):
 * if these two ever drift, the pre-check stops
 * matching the constraint and the raw Postgres error leaks to the analyst.
 */
const LIVE_CASE_STATUSES = ["open", "in_review"] as const;
type LiveCaseStatus = (typeof LIVE_CASE_STATUSES)[number];

function isLiveCaseStatus(status: string): status is LiveCaseStatus {
  return (LIVE_CASE_STATUSES as readonly string[]).includes(status);
}

/** SQLSTATE 23505 — unique_violation. */
const UNIQUE_VIOLATION = "23505";

/**
 * Shown whenever an optimistic guard rejects a write, i.e. the row moved
 * between the analyst loading the case and clicking. Never silently overwrite:
 * two analysts closing the same case in the same second would otherwise both
 * "succeed", the last writer would win arbitrarily, `resolved_by` would name
 * someone who did not set the final status, and the trail would carry two
 * contradictory notes for one transition.
 */
const STALE_CASE_MESSAGE =
  "Someone else changed this case while you were working on it — reload and try again.";

const openReviewSchema = z.object({
  // MAIN-DB user id — a loose string, so validate shape not existence.
  targetUserId: z
    .string()
    .trim()
    .min(1, "A player id is required")
    .max(64, "That id looks wrong"),
  targetUsername: z
    .string()
    .trim()
    .max(64, "Username is too long")
    .optional()
    .or(z.literal("")),
  reason: z
    .string()
    .trim()
    .min(4, "Say why this account is being reviewed")
    .max(500, "Keep the reason under 500 characters"),
});

export type OpenReviewResult =
  | { ok: true; id: string }
  | {
      ok: false;
      reason: "duplicate_live_case";
      message: string;
      conflictReviewId: string | null;
    };

async function findLiveReview(
  targetUserId: string,
): Promise<{ id: string } | null> {
  const [live] = await adminDrizzle.select({ id: antifraud_reviews.id })
    .from(antifraud_reviews).where(and(
      eq(antifraud_reviews.target_user_id, targetUserId),
      inArray(antifraud_reviews.status, [...LIVE_CASE_STATUSES]),
    )).limit(1);
  return live ?? null;
}

/** Manually open a case on an account. */
export async function openReview(input: unknown): Promise<OpenReviewResult> {
  const session = await requireAntifraudAccess();
  const parsed = openReviewSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const { targetUserId, targetUsername, reason } = parsed.data;

  type OpenOutcome =
    | { kind: "created"; id: string }
    | { kind: "conflict"; id: string | null };

  let outcome: OpenOutcome;
  try {
    outcome = await adminDrizzle.transaction(async (tx): Promise<OpenOutcome> => {
      // Friendly fast path. The partial unique index remains the authoritative
      // race guard when two analysts both observe "no row".
      const [live] = await tx.select({ id: antifraud_reviews.id })
        .from(antifraud_reviews).where(and(
          eq(antifraud_reviews.target_user_id, targetUserId),
          inArray(antifraud_reviews.status, [...LIVE_CASE_STATUSES]),
        )).limit(1);
      if (live) return { kind: "conflict", id: live.id };

      const [created] = await tx.insert(antifraud_reviews).values({
        target_user_id: targetUserId,
        target_username: targetUsername ? targetUsername : null,
        status: "open",
        severity: "medium",
        source: "manual",
        reason,
        opened_by: session.userId,
      }).returning({ id: antifraud_reviews.id });
      if (!created) throw new Error("Review insert returned no row");

      await tx.insert(antifraud_review_notes).values({
        review_id: created.id,
        admin_user_id: session.userId,
        kind: "status",
        body: "Case opened.",
      });

      await tx.insert(admin_audit_events).values({
        admin_user_id: session.userId,
        event_type: "antifraud_review_opened",
        target_user_id: targetUserId,
        metadata: { reviewId: created.id, reason },
      });

      return { kind: "created", id: created.id };
    });
  } catch (err) {
    if (!isPostgresError(err, UNIQUE_VIOLATION)) throw err;
    outcome = {
      kind: "conflict",
      id: (await findLiveReview(targetUserId))?.id ?? null,
    };
  }

  if (outcome.kind === "conflict") {
    return {
      ok: false,
      reason: "duplicate_live_case",
      message:
        "That account already has a live case. Open the existing case instead.",
      conflictReviewId: outcome.id,
    };
  }

  revalidatePath("/antifraud/reviews");
  revalidatePath("/antifraud");
  return { ok: true, id: outcome.id };
}

/** Verdict statuses: they stamp a resolver and REQUIRE a written conclusion. */
const TERMINAL_STATUSES = ["cleared", "flagged"] as const;

function isTerminalStatus(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

const updateStatusSchema = z
  .object({
    reviewId: uuid,
    status: z.enum(REVIEW_STATUSES),
    resolution: z
      .string()
      .trim()
      .max(500, "Keep the note under 500 characters")
      .optional()
      .or(z.literal("")),
    /**
     * The status the analyst was LOOKING AT when they clicked. Optional so a
     * caller that genuinely has no prior view still works, but the case
     * controls always send it — it is what turns "last write wins" into
     * "the stale tab is told to reload".
     */
    expectedStatus: z.enum(REVIEW_STATUSES).optional(),
    idempotencyKey: z.string().uuid("Invalid idempotency key"),
  })
  // Server-side is the real gate. The buttons are also disabled client-side
  // without a conclusion, but a terminal transition that NULLs `resolution`
  // closes a case, stamps a resolver, and records nothing about WHY —
  // an audit trail with a hole in it exactly where the verdict belongs.
  .refine(
    (value) => !isTerminalStatus(value.status) || Boolean(value.resolution?.trim()),
    {
      path: ["resolution"],
      message: "Write what you concluded before clearing or flagging a case.",
    },
  );

/**
 * What the withdrawal release did, so the UI can say so instead of leaving the
 * analyst to guess. `failed` is the one the analyst must act on: the verdict
 * stands but the account is still locked.
 */
export type WithdrawalReleaseStatus =
  | "released"
  | "already_open"
  | "failed"
  /** Not a clearing transition — nothing was attempted. */
  | "not_applicable";

export type UpdateReviewStatusResult =
  | { ok: true; withdrawalRelease: WithdrawalReleaseStatus }
  | {
      ok: false;
      reason: "duplicate_live_case";
      message: string;
      /** The case that already holds the live slot, for a "go there" link. */
      conflictReviewId: string | null;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertStatusReplayMatches(
  existing: {
    adminUserId: string | null;
    metadata: unknown;
  } | undefined,
  expected: {
    adminUserId: string;
    reviewId: string;
    status: string;
    resolution: string | null;
  },
): void {
  const stored = existing?.metadata;
  if (
    !existing ||
    existing.adminUserId !== expected.adminUserId ||
    !isRecord(stored) ||
    stored.reviewId !== expected.reviewId ||
    stored.to !== expected.status ||
    (stored.resolution ?? null) !== expected.resolution
  ) {
    throw new Error(
      "That status retry key was already used for a different command.",
    );
  }
}

/**
 * The account consequence of a "cleared" verdict: release the withdrawal
 * locks, record it on the case trail, and drop the cached user detail so
 * /users/[id] stops showing a lock that no longer exists.
 *
 * Runs AFTER the ADMIN transaction commits — the release is a cross-database
 * write and cannot join that transaction. It is therefore written to be
 * re-runnable: a replayed status command runs it again, which repairs the
 * "verdict committed, release never ran" window instead of leaving the account
 * locked forever.
 *
 * No extra capability gate. Closing a case as fine IS the decision to let the
 * player withdraw again, and gating the consequence behind
 * `__can_toggle_feature_locks` would silently turn most clears back into the
 * old lock-survives-the-verdict behaviour. The release is fully audited and
 * reversible from /users/[id].
 */
async function releaseClearedCaseWithdrawals(params: {
  reviewId: string;
  targetUserId: string;
  adminUserId: string;
  idempotencyKey: string;
}): Promise<WithdrawalReleaseStatus> {
  const outcome = await releaseWithdrawalLocksForClearedCase({
    userId: params.targetUserId,
    adminUserId: params.adminUserId,
    reviewId: params.reviewId,
    idempotencyKey: params.idempotencyKey,
  });

  if (outcome.status === "released") {
    // Best effort — the trail note must never turn a successful release into
    // a reported failure.
    try {
      await adminDrizzle.insert(antifraud_review_notes).values({
        review_id: params.reviewId,
        admin_user_id: params.adminUserId,
        kind: "action",
        body:
          "Cleared: crypto and item withdrawals unlocked " +
          `(was ${outcome.previousCrypto.length > 0 ? "crypto" : "no crypto"}` +
          `${outcome.previousItems ? " + items" : ""} locked).`,
      });
    } catch (error) {
      console.error("[antifraud] release note failed:", error);
    }
    revalidateTag(userDetailTag(params.targetUserId));
  }

  return outcome.status;
}

/**
 * Move a case along. Setting a terminal status (cleared / flagged) stamps the
 * resolver + timestamp and stores the written conclusion; any NON-terminal
 * transition (re-opening or returning to review) clears resolver, timestamp AND the
 * conclusion together — a withdrawn verdict must not survive as the case's
 * standing conclusion under an "In review" badge.
 *
 * The read, the guarded UPDATE and the trail note run in ONE transaction with
 * the UPDATE conditional on the status observed inside it, so two analysts
 * acting on the same case in the same second cannot both "succeed": the loser
 * matches zero rows and is told to reload instead of silently overwriting the
 * winner's verdict.
 */
export async function updateReviewStatus(
  input: unknown,
): Promise<UpdateReviewStatusResult> {
  const session = await requireAntifraudAccess();
  const parsed = updateStatusSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const { reviewId, status, expectedStatus, idempotencyKey } = parsed.data;
  const resolution = parsed.data.resolution?.trim() || null;
  const isTerminal = isTerminalStatus(status);

  type Applied = {
    openedBy: string | null;
  };
  type Outcome =
    | { kind: "noop" }
    // Both carry the subject so the post-commit withdrawal release can run
    // without a second lookup — including on a replay, which is what repairs a
    // clear whose release never got to run.
    | { kind: "replayed"; targetUserId: string }
    | { kind: "applied"; applied: Applied; targetUserId: string }
    | { kind: "conflict"; conflictReviewId: string | null };

  const runTransaction = async (): Promise<Outcome> =>
    adminDrizzle.transaction(async (tx): Promise<Outcome> => {
      const [current] = await tx.select({
        status: antifraud_reviews.status,
        target_user_id: antifraud_reviews.target_user_id,
        opened_by: antifraud_reviews.opened_by,
        resolved_by: antifraud_reviews.resolved_by,
        updated_at: antifraud_reviews.updated_at,
      }).from(antifraud_reviews).where(eq(antifraud_reviews.id, reviewId)).limit(1);
      if (!current) throw new Error("That case no longer exists");

      const replayPredicate = and(
        eq(admin_audit_events.event_type, "antifraud_review_status_changed"),
        sql`${admin_audit_events.metadata} ->> 'idempotencyKey' = ${idempotencyKey}`,
      );
      const [existingReplay] = await tx.select({
        adminUserId: admin_audit_events.admin_user_id,
        metadata: admin_audit_events.metadata,
      }).from(admin_audit_events).where(replayPredicate).limit(1);
      if (existingReplay) {
        assertStatusReplayMatches(existingReplay, {
          adminUserId: session.userId,
          reviewId,
          status,
          resolution,
        });
        return { kind: "replayed", targetUserId: current.target_user_id };
      }

      // Stale-view guard: the analyst decided against a status that is no
      // longer the truth.
      if (expectedStatus && current.status !== expectedStatus) {
        throw new Error(STALE_CASE_MESSAGE);
      }
      if (current.status === status && !resolution) return { kind: "noop" };

      // Re-opening a closed case into the live set collides with the partial
      // unique index if the player already picked up a newer live case.
      // Without this, the analyst saw the raw Postgres constraint text.
      if (isLiveCaseStatus(status) && !isLiveCaseStatus(current.status)) {
        const [live] = await tx.select({ id: antifraud_reviews.id })
          .from(antifraud_reviews).where(and(
            eq(antifraud_reviews.target_user_id, current.target_user_id),
            inArray(antifraud_reviews.status, [...LIVE_CASE_STATUSES]),
            ne(antifraud_reviews.id, reviewId),
          )).limit(1);
        if (live) return { kind: "conflict", conflictReviewId: live.id };
      }

      const auditMetadata = {
        reviewId,
        from: current.status,
        to: status,
        resolution,
        idempotencyKey,
      };
      const insertedAudit = await tx.insert(admin_audit_events).values({
        admin_user_id: session.userId,
        event_type: "antifraud_review_status_changed",
        target_user_id: current.target_user_id,
        metadata: auditMetadata,
      }).onConflictDoNothing().returning({ id: admin_audit_events.id });
      if (insertedAudit.length === 0) {
        const [racedReplay] = await tx.select({
          adminUserId: admin_audit_events.admin_user_id,
          metadata: admin_audit_events.metadata,
        }).from(admin_audit_events).where(replayPredicate).limit(1);
        assertStatusReplayMatches(racedReplay, {
          adminUserId: session.userId,
          reviewId,
          status,
          resolution,
        });
        return { kind: "replayed", targetUserId: current.target_user_id };
      }

      const updated = await tx.update(antifraud_reviews).set({
        status,
        // Symmetric: a verdict writes the conclusion, anything else erases it.
        resolution: isTerminal ? resolution : null,
        resolved_by: isTerminal ? session.userId : null,
        resolved_at: isTerminal ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      }).where(and(
        eq(antifraud_reviews.id, reviewId),
        eq(antifraud_reviews.status, current.status),
        eq(antifraud_reviews.updated_at, current.updated_at),
      )).returning({ id: antifraud_reviews.id });
      // READ COMMITTED re-checks the predicate after the row lock is granted,
      // so a concurrent transition makes this match nothing.
      if (updated.length === 0) throw new Error(STALE_CASE_MESSAGE);

      await tx.insert(antifraud_review_notes).values({
        review_id: reviewId,
        admin_user_id: session.userId,
        kind: "status",
        body: resolution
          ? `${REVIEW_STATUS_LABELS[status]} — ${resolution}`
          : `Status changed to ${REVIEW_STATUS_LABELS[status]}.`,
      });

      // The members board credits the analyst whose verdict is currently
      // standing. Move that single credit inside the same transaction as the
      // guarded case update and trail note, so a racing loser cannot inflate
      // the counter and reopening cannot leave a withdrawn verdict credited.
      const nextResolver = isTerminal ? session.userId : null;
      if (current.resolved_by !== nextResolver) {
        if (current.resolved_by) {
          await tx.update(staff_profiles).set({
            reviews_resolved: sql`greatest(0, ${staff_profiles.reviews_resolved} - 1)`,
            updated_at: new Date().toISOString(),
          }).where(eq(staff_profiles.admin_user_id, current.resolved_by));
        }
        if (nextResolver) {
          await tx.insert(staff_profiles).values({
            admin_user_id: nextResolver,
            reviews_resolved: 1,
          }).onConflictDoUpdate({
            target: staff_profiles.admin_user_id,
            set: {
              reviews_resolved: sql`${staff_profiles.reviews_resolved} + 1`,
              updated_at: new Date().toISOString(),
            },
          });
        }
      }

      return {
        kind: "applied",
        targetUserId: current.target_user_id,
        applied: {
          openedBy: current.opened_by,
        },
      };
    });

  let outcome: Outcome;
  try {
    outcome = await runTransaction();
  } catch (err) {
    // Belt and braces: the pre-check above closes the window we can see, the
    // constraint closes the one we cannot (two re-opens racing each other).
    if (isPostgresError(err, UNIQUE_VIOLATION)) {
      const [subject] = await adminDrizzle.select({
        targetUserId: antifraud_reviews.target_user_id,
      }).from(antifraud_reviews)
        .where(eq(antifraud_reviews.id, reviewId))
        .limit(1);
      const [live] = subject
        ? await adminDrizzle.select({ id: antifraud_reviews.id })
            .from(antifraud_reviews).where(and(
              eq(antifraud_reviews.target_user_id, subject.targetUserId),
              inArray(antifraud_reviews.status, [...LIVE_CASE_STATUSES]),
              ne(antifraud_reviews.id, reviewId),
            )).limit(1)
        : [];
      outcome = { kind: "conflict", conflictReviewId: live?.id ?? null };
    } else {
      throw err;
    }
  }

  if (outcome.kind === "conflict") {
    return {
      ok: false,
      reason: "duplicate_live_case",
      message:
        "That player already has a live case, so this one can't be re-opened. Close the live case first.",
      conflictReviewId: outcome.conflictReviewId,
    };
  }
  if (outcome.kind === "noop") {
    return { ok: true, withdrawalRelease: "not_applicable" };
  }

  // A cleared verdict releases the account's withdrawal locks. This runs on a
  // replay too: the release is idempotent, and re-running it is what repairs a
  // clear whose post-commit step died before the account was unlocked.
  const withdrawalRelease: WithdrawalReleaseStatus =
    status === "cleared"
      ? await releaseClearedCaseWithdrawals({
          reviewId,
          targetUserId: outcome.targetUserId,
          adminUserId: session.userId,
          idempotencyKey,
        })
      : "not_applicable";

  // On a replay a previous response may have failed during cache invalidation
  // after the transaction committed — re-running these is safe either way.
  revalidatePath("/antifraud/reviews");
  revalidatePath(`/antifraud/reviews/${reviewId}`);
  revalidatePath("/antifraud");
  return { ok: true, withdrawalRelease };
}

const quickAccountActionSchema = z.object({
  reviewId: uuid,
  action: z.enum(["fine", "ban", "lock_withdrawals"]),
  expectedStatus: z.enum(REVIEW_STATUSES),
  idempotencyKey: z.string().uuid("Invalid idempotency key"),
  credential: z.string().trim().max(4_096).optional(),
});

export type QuickReviewAccountAction =
  z.infer<typeof quickAccountActionSchema>["action"];

export type QuickReviewAccountActionResult = {
  /** Only ever meaningful for `fine`; every other action reports `not_applicable`. */
  withdrawalRelease: WithdrawalReleaseStatus;
};

/**
 * Account Review's deliberately small containment surface. The analyst clicks
 * once, confirms once in the client, and this action performs the mutation
 * without a second-factor prompt. Server-side workspace/capability checks,
 * MAIN audit records, and the case trail remain mandatory.
 *
 * `fine` clears the case, which releases the player's withdrawal locks through
 * the shared `updateReviewStatus` path — the two entry points cannot disagree
 * about what a clear means.
 */
export async function runQuickReviewAccountAction(
  input: unknown,
): Promise<QuickReviewAccountActionResult> {
  const session = await requireAntifraudAccess();
  const parsed = quickAccountActionSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const { reviewId, action, expectedStatus, idempotencyKey } = parsed.data;

  const [review] = await adminDrizzle
    .select({
      targetUserId: antifraud_reviews.target_user_id,
      targetUsername: antifraud_reviews.target_username,
      status: antifraud_reviews.status,
      reason: antifraud_reviews.reason,
    })
    .from(antifraud_reviews)
    .where(eq(antifraud_reviews.id, reviewId))
    .limit(1);
  if (!review) throw new Error("That case no longer exists");
  if (review.status !== expectedStatus) throw new Error(STALE_CASE_MESSAGE);
  if (isTerminalStatus(review.status)) {
    throw new Error("This case is already closed.");
  }

  if (action === "fine") {
    const result = await updateReviewStatus({
      reviewId,
      status: "cleared",
      expectedStatus,
      resolution: "Account marked fine from Account Review.",
      idempotencyKey,
    });
    if (!result.ok) throw new Error(result.message);
    return { withdrawalRelease: result.withdrawalRelease };
  }

  await require2FA(session.userId, parsed.data.credential);

  if (action === "ban") {
    await requireCapability(session, "__can_ban_users", "ban users");
    const db = await getPrimaryDrizzleDb();
    const issuerMainUserId = await resolveAdminMainUserId(session.userId);
    const reason = `Antifraud review ${reviewId}: ${review.reason}`.slice(0, 500);

    try {
      await db.transaction(async (tx) => {
        const updated = await tx.execute<{ id: string }>(sql`
          UPDATE "user"
          SET is_banned = TRUE,
              banned_reason = ${reason},
              banned_at = NOW(),
              banned_by = ${issuerMainUserId},
              updated_at = NOW()
          WHERE id = ${review.targetUserId}
          RETURNING id
        `);
        if (updated.rows.length === 0) throw new Error("User not found");
        await tx.execute(
          sql`DELETE FROM session WHERE "userId" = ${review.targetUserId}`,
        );
      });
    } catch (error) {
      console.error("[antifraud] quick review ban failed:", error);
      throw new Error("The account could not be banned. Nothing was hidden.");
    }

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "account_banned",
      targetUserId: review.targetUserId,
      metadata: {
        // Scopes the row to the Fraud staff audit log — `account_banned` is
        // also written from /users (see lib/antifraud/staff-audit.ts).
        source: "antifraud_reviews",
        reason,
        issuer_main_user_id: issuerMainUserId,
        reviewId,
        idempotencyKey,
      },
    });
    revalidateTag("users-list");
    revalidateTag("users-list-stats");
    revalidateTag(userDetailTag(review.targetUserId));

    const result = await updateReviewStatus({
      reviewId,
      status: "flagged",
      expectedStatus,
      resolution: "Account banned from Account Review.",
      idempotencyKey,
    });
    if (!result.ok) throw new Error(result.message);
    return { withdrawalRelease: "not_applicable" };
  }

  await requireCapability(
    session,
    "__can_toggle_feature_locks",
    "lock withdrawals",
  );
  const db = await getPrimaryDrizzleDb();
  const issuerMainUserId = await resolveAdminMainUserId(session.userId);
  const lockReason = `Antifraud review ${reviewId}`;
  try {
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
        ${issuerMainUserId},
        ${lockReason},
        NOW(),
        NOW()
      FROM "user" u
      WHERE u.id = ${review.targetUserId}
      ON CONFLICT (user_id) DO UPDATE SET
        locked_withdrawals_crypto = EXCLUDED.locked_withdrawals_crypto,
        locked_withdrawals_items = EXCLUDED.locked_withdrawals_items,
        locked_withdrawals_at = EXCLUDED.locked_withdrawals_at,
        locked_withdrawals_by = EXCLUDED.locked_withdrawals_by,
        locked_withdrawals_reason = EXCLUDED.locked_withdrawals_reason,
        updated_at = NOW()
      RETURNING user_id
    `);
    if (locked.rows.length === 0) throw new Error("User not found");
  } catch (error) {
    console.error("[antifraud] quick review withdrawal lock failed:", error);
    throw new Error(
      "Withdrawals could not be locked. The case was left unchanged.",
    );
  }

  const lockMetadata = {
    source: "antifraud_review",
    reviewId,
    idempotencyKey,
    crypto: "all",
    items: true,
  };
  await Promise.all([
    createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "antifraud_withdrawals_locked",
      targetUserId: review.targetUserId,
      metadata: lockMetadata,
    }),
    // Mirror the /users feature-lock vocabulary as well. Without these the
    // account-level "staff checked" history could never see an antifraud lock,
    // so a later clear had no lock to pair its release against.
    createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "locked_withdrawals_crypto_enabled",
      targetUserId: review.targetUserId,
      metadata: {
        ...lockMetadata,
        feature: "locked_withdrawals_crypto",
        locked: true,
      },
    }),
    createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "locked_withdrawals_items_enabled",
      targetUserId: review.targetUserId,
      metadata: {
        ...lockMetadata,
        feature: "locked_withdrawals_items",
        locked: true,
      },
    }),
    adminDrizzle.insert(antifraud_review_notes).values({
      review_id: reviewId,
      admin_user_id: session.userId,
      kind: "action",
      body: `Locked crypto and item withdrawals for ${
        review.targetUsername ?? review.targetUserId
      }.`,
    }),
  ]);

  revalidateTag(userDetailTag(review.targetUserId));
  revalidatePath("/antifraud/reviews");
  revalidatePath(`/antifraud/reviews/${reviewId}`);
  return { withdrawalRelease: "not_applicable" };
}

const assignSchema = z.object({
  reviewId: uuid,
  /** null / "" un-assigns. */
  adminUserId: z.union([uuid, z.literal("")]).nullable().optional(),
});

/** Put a case in someone's queue (or take it yourself, or clear it). */
export async function assignReview(input: unknown): Promise<void> {
  const session = await requireAntifraudAccess();
  const parsed = assignSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const { reviewId } = parsed.data;
  const assignee = parsed.data.adminUserId ? parsed.data.adminUserId : null;

  if (assignee) {
    // The assignee is client-supplied. Re-read their full identity and apply
    // the same live access decision as the workspace gate before disclosing a
    // case or putting it in their queue.
    const [[target], settings, userAccess] = await Promise.all([
      adminDrizzle.select({
        username: admin_users.username,
        role: admin_users.role,
        roles: admin_users.roles,
        is_active: admin_users.is_active,
      }).from(admin_users).where(eq(admin_users.id, assignee)).limit(1),
      getAntifraudAccessSettings(),
      getAntifraudUserAccess(),
    ]);
    if (!target || !isAssignableAnalyst(target, settings, userAccess)) {
      throw new Error("That staff account cannot be assigned Antifraud cases");
    }
  }

  // Same optimistic shape as updateReviewStatus: read, guarded UPDATE and note
  // in one transaction, conditional on BOTH observed columns, so two analysts
  // grabbing the same case in the same second can't both write a "picked this
  // case up" note while only one assignment survives.
  const applied = await adminDrizzle.transaction(async (tx) => {
    const [current] = await tx.select({
      assigned_to: antifraud_reviews.assigned_to, status: antifraud_reviews.status,
      reason: antifraud_reviews.reason,
    }).from(antifraud_reviews).where(eq(antifraud_reviews.id, reviewId)).limit(1);
    if (!current) throw new Error("That case no longer exists");
    if (current.assigned_to === assignee) return null;

    // Picking a case up moves it out of the untouched "open" bucket. Both
    // 'open' and 'in_review' sit inside the live-case unique index, so this
    // transition can never collide with it.
    const nextStatus =
      assignee && current.status === "open" ? "in_review" : current.status;

    const updated = await tx.update(antifraud_reviews).set({
      assigned_to: assignee,
      status: nextStatus,
      updated_at: new Date().toISOString(),
    }).where(and(
      eq(antifraud_reviews.id, reviewId),
      eq(antifraud_reviews.status, current.status),
      // `= NULL` is never true — an unassigned case needs the null-safe form.
      sql`${antifraud_reviews.assigned_to} IS NOT DISTINCT FROM ${current.assigned_to}::uuid`,
    )).returning({ id: antifraud_reviews.id });
    if (updated.length === 0) throw new Error(STALE_CASE_MESSAGE);

    await tx.insert(antifraud_review_notes).values({
      review_id: reviewId,
      admin_user_id: session.userId,
      kind: "assign",
      body: assignee
        ? assignee === session.userId
          ? "Picked this case up."
          : "Assigned this case to another analyst."
        : "Unassigned this case.",
    });

    return { reason: current.reason };
  });
  if (!applied) return;

  revalidatePath("/antifraud/reviews");
  revalidatePath(`/antifraud/reviews/${reviewId}`);
}

const noteSchema = z.object({
  reviewId: uuid,
  body: z
    .string()
    .trim()
    .min(2, "Write something first")
    .max(2000, "Keep notes under 2000 characters"),
});

const postponeSchema = z.object({
  reviewId: uuid,
  idempotencyKey: z.string().uuid("Invalid idempotency key"),
});

/** Hide a live case from active queues and reminders for exactly 2.5 hours. */
export async function postponeReview(input: unknown): Promise<void> {
  const session = await requireAntifraudAccess();
  const parsed = postponeSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const { reviewId, idempotencyKey } = parsed.data;

  await adminDrizzle.transaction(async (tx) => {
    const [replay] = await tx
      .select({ id: admin_audit_events.id })
      .from(admin_audit_events)
      .where(and(
        eq(admin_audit_events.event_type, "antifraud_review_postponed"),
        sql`${admin_audit_events.metadata} ->> 'idempotencyKey' = ${idempotencyKey}`,
      ))
      .limit(1);
    if (replay) return;

    const [review] = await tx
      .select({
        status: antifraud_reviews.status,
        targetUserId: antifraud_reviews.target_user_id,
      })
      .from(antifraud_reviews)
      .where(eq(antifraud_reviews.id, reviewId))
      .limit(1);
    if (!review) throw new Error("That case no longer exists");
    if (!isLiveCaseStatus(review.status)) {
      throw new Error("Only a live review can be postponed");
    }

    const dueAt = new Date(
      Date.now() + REVIEW_REMINDER_DELAYS_MS.postponed,
    );
    const [audit] = await tx.insert(admin_audit_events).values({
      admin_user_id: session.userId,
      event_type: "antifraud_review_postponed",
      target_user_id: review.targetUserId,
      metadata: {
        reviewId,
        dueAt: dueAt.toISOString(),
        idempotencyKey,
      },
    }).onConflictDoNothing().returning({ id: admin_audit_events.id });
    if (!audit) return;

    await tx.execute(sql`
      INSERT INTO antifraud_review_workflow (
        review_id,
        queue_state,
        evidence,
        postponed_until,
        postponed_by,
        state_updated_at,
        updated_at
      )
      VALUES (
        ${reviewId}::uuid,
        'normal',
        '{}'::jsonb,
        ${dueAt},
        ${session.userId}::uuid,
        now(),
        now()
      )
      ON CONFLICT (review_id) DO UPDATE SET
        postponed_until = EXCLUDED.postponed_until,
        postponed_by = EXCLUDED.postponed_by,
        updated_at = now()
    `);
    await tx.execute(sql`
      INSERT INTO antifraud_review_reminder_state (
        review_id,
        reminder_kind,
        next_reminder_at,
        lease_token,
        leased_until,
        updated_at
      )
      VALUES (
        ${reviewId}::uuid,
        'postponed',
        ${dueAt},
        NULL,
        NULL,
        now()
      )
      ON CONFLICT (review_id) DO UPDATE SET
        reminder_kind = 'postponed',
        next_reminder_at = EXCLUDED.next_reminder_at,
        lease_token = NULL,
        leased_until = NULL,
        updated_at = now()
    `);
    await tx.insert(antifraud_review_notes).values({
      review_id: reviewId,
      admin_user_id: session.userId,
      kind: "postponed",
      body: "Postponed for 2.5 hours. Active reminders are suppressed until due.",
    });
  });

  revalidatePath("/antifraud/reviews");
  revalidatePath(`/antifraud/reviews/${reviewId}`);
}

/** Append an analyst note to a case. */
export async function addReviewNote(input: unknown): Promise<void> {
  const session = await requireAntifraudAccess();
  const parsed = noteSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);

  const [exists] = await adminDrizzle.select({ id: antifraud_reviews.id })
    .from(antifraud_reviews).where(eq(antifraud_reviews.id, parsed.data.reviewId)).limit(1);
  if (!exists) throw new Error("That case no longer exists");

  await adminDrizzle.insert(antifraud_review_notes).values({
      review_id: parsed.data.reviewId,
      admin_user_id: session.userId,
      kind: "note",
      body: parsed.data.body,
  });

  revalidatePath(`/antifraud/reviews/${parsed.data.reviewId}`);
}
