"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import { and, eq, inArray, ne, sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import {
  createAdminAuditEvent,
  createAdminAuditEventDurable,
} from "@/lib/admin-audit";
import {
  admin_audit_events,
  admin_users,
  antifraud_review_notes,
  antifraud_reviews,
  staff_profiles,
} from "@/lib/db-schema/admin/schema";
import { requireAntifraudAccess } from "@/lib/require-antifraud-access";
import { requireAntifraudManager } from "@/lib/require-antifraud-access";
import { require2FA } from "@/lib/require-2fa";
import { requireCapability } from "@/lib/require-capability";
import { getPrimaryDrizzleDb } from "@/lib/db";
import { resolveAdminMainUserId } from "@/lib/resolve-admin-main-user-id";
import { userDetailTag } from "@/lib/queries/users-detail-cache";
import { blockKnownUserIdentifiers } from "@/lib/antifraud/user-identifier-blocking";
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
import {
  releaseWithdrawalLocksForClearedCase,
  restoreWithdrawalLocksForReopenedCase,
} from "@/lib/antifraud/withdrawal-release";
import { REVIEW_REMINDER_DELAYS_MS } from "@/lib/discord-notifications/antifraud-policy";
import { submitAntifraudCaseDecision } from "@/lib/antifraud/monitor-api";
import { requireAccountKyc } from "../kyc/actions";
import {
  getFingerprintAltAccounts,
  type FingerprintAltAccount,
} from "@/lib/queries/user-fingerprint-alts";
import { pgArrayParam } from "@/lib/drizzle-array-param";
import { promoteConfirmedCatchallDomainsForReview } from "@/lib/antifraud/catchall-domain-promotion";

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
 * What the withdrawal side of the verdict did, so the UI can say so instead of
 * leaving the analyst to guess. The two `*_failed` values are the ones the
 * analyst must act on: the status moved but the account did not follow.
 */
export type WithdrawalReleaseStatus =
  // Clearing a case.
  | "released"
  | "already_open"
  /** Withdrawals stay locked: only an owner/admin can lift a KYC gate. */
  | "kyc_gated"
  | "failed"
  // Leaving `cleared` again — the release is withdrawn with the verdict.
  | "relocked"
  /** This case's clear never released anything, so there was nothing to undo. */
  | "nothing_to_restore"
  | "relock_failed"
  /** Neither a clearing nor an un-clearing transition. */
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

function monitorCaseIdFromMetadata(metadata: unknown): string | null {
  if (!isRecord(metadata)) return null;
  const value = metadata.monitorCaseId;
  return typeof value === "string" && uuid.safeParse(value).success
    ? value
    : null;
}

async function syncLinkedMonitorCase(input: {
  monitorCaseId: string | null;
  decision: "in_review" | "resolved_safe" | "resolved_fraud";
  reason: string;
  idempotencyKey: string;
  actorId: string;
  actorUsername?: string;
}): Promise<void> {
  if (!input.monitorCaseId) return;
  await submitAntifraudCaseDecision({
    caseId: input.monitorCaseId,
    decision: input.decision,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
    actorId: input.actorId,
    actorUsername: input.actorUsername,
  });
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
 * The status the ORIGINAL command moved away from, read back off its audit
 * row. On a replay the case already holds the new status, so `current.status`
 * cannot answer "was this a clear, or the withdrawal of one?" — only the
 * recorded `from` can.
 */
function replayedFromStatus(metadata: unknown): string | null {
  if (!isRecord(metadata)) return null;
  return typeof metadata.from === "string" ? metadata.from : null;
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
 *
 * The ONE thing a clear cannot lift is a KYC gate — that stays owner/admin +
 * 2FA only, enforced inside the release helper.
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
        body: [
          outcome.releasedFiat ? "Fiat deposits" : null,
          outcome.previousCrypto.length > 0 ? "crypto withdrawals" : null,
          outcome.previousItems ? "item withdrawals" : null,
          outcome.releasedRewardCategories.length > 0
            ? "all automatic reward restrictions"
            : null,
        ].filter(Boolean).join(", ") + " unlocked after approval.",
      });
    } catch (error) {
      console.error("[antifraud] release note failed:", error);
    }
    revalidateTag(userDetailTag(params.targetUserId));
  } else if (outcome.status === "kyc_gated") {
    // Worth a trail entry: the case is closed but the account is still locked,
    // and the trail should say why rather than look like a missing release.
    try {
      await adminDrizzle.insert(antifraud_review_notes).values({
        review_id: params.reviewId,
        admin_user_id: params.adminUserId,
        kind: "action",
        body:
          "Cleared, but withdrawals stay locked: this account is awaiting a " +
          "KYC decision, which only an owner or admin can make.",
      });
    } catch (error) {
      console.error("[antifraud] kyc-gated release note failed:", error);
    }
  }

  return outcome.status;
}

/**
 * The mirror image: leaving `cleared` withdraws the verdict, so it withdraws
 * the release too. Reopening, sending back to review or flagging all re-lock.
 *
 * Only ever restores what THIS case released (see the helper) — reopening a
 * case on an account nobody had locked must not invent a lock.
 */
async function restoreReopenedCaseWithdrawals(params: {
  reviewId: string;
  targetUserId: string;
  adminUserId: string;
  idempotencyKey: string;
}): Promise<WithdrawalReleaseStatus> {
  const outcome = await restoreWithdrawalLocksForReopenedCase({
    userId: params.targetUserId,
    adminUserId: params.adminUserId,
    reviewId: params.reviewId,
    idempotencyKey: params.idempotencyKey,
  });

  if (outcome.status === "relocked") {
    try {
      await adminDrizzle.insert(antifraud_review_notes).values({
        review_id: params.reviewId,
        admin_user_id: params.adminUserId,
        kind: "action",
        body:
          "Verdict withdrawn: crypto and item withdrawals locked again until " +
          "this case is closed.",
      });
    } catch (error) {
      console.error("[antifraud] re-lock note failed:", error);
    }
    revalidateTag(userDetailTag(params.targetUserId));
  }

  return outcome.status === "nothing_to_restore"
    ? "nothing_to_restore"
    : outcome.status === "failed"
      ? "relock_failed"
      : "relocked";
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
    // Both carry the subject AND the status we moved away from, so the
    // post-commit withdrawal step can release or re-lock without a second
    // lookup — including on a replay, which is what repairs a transition whose
    // account-side effect never got to run.
    | {
        kind: "replayed";
        targetUserId: string;
        previousStatus: string | null;
        monitorCaseId: string | null;
      }
    | {
        kind: "applied";
        applied: Applied;
        targetUserId: string;
        previousStatus: string;
        monitorCaseId: string | null;
      }
    | { kind: "conflict"; conflictReviewId: string | null };

  const runTransaction = async (): Promise<Outcome> =>
    adminDrizzle.transaction(async (tx): Promise<Outcome> => {
      const [current] = await tx.select({
        status: antifraud_reviews.status,
        target_user_id: antifraud_reviews.target_user_id,
        assigned_to: antifraud_reviews.assigned_to,
        opened_by: antifraud_reviews.opened_by,
        resolved_by: antifraud_reviews.resolved_by,
        updated_at: antifraud_reviews.updated_at,
        metadata: antifraud_reviews.metadata,
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
        return {
          kind: "replayed",
          targetUserId: current.target_user_id,
          previousStatus: replayedFromStatus(existingReplay.metadata),
          monitorCaseId: monitorCaseIdFromMetadata(current.metadata),
        };
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
        return {
          kind: "replayed",
          targetUserId: current.target_user_id,
          previousStatus: replayedFromStatus(racedReplay?.metadata),
          monitorCaseId: monitorCaseIdFromMetadata(current.metadata),
        };
      }

      const updated = await tx.update(antifraud_reviews).set({
        status,
        // An In Review case is active staff work, so it must always name the
        // analyst responsible for it. Preserve an existing owner; otherwise
        // the staff member making the transition takes the case.
        assigned_to:
          status === "in_review"
            ? current.assigned_to ?? session.userId
            : current.assigned_to,
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
        previousStatus: current.status,
        monitorCaseId: monitorCaseIdFromMetadata(current.metadata),
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

  // The account follows the verdict in BOTH directions: clearing releases the
  // withdrawal locks, and leaving `cleared` again (reopen, back to review, or
  // flag) puts them back. Both run on a replay too — they are idempotent, and
  // re-running is what repairs a transition whose post-commit step died before
  // the account caught up.
  const withdrawalRelease: WithdrawalReleaseStatus =
    status === "cleared"
      ? await releaseClearedCaseWithdrawals({
          reviewId,
          targetUserId: outcome.targetUserId,
          adminUserId: session.userId,
          idempotencyKey,
        })
      : outcome.previousStatus === "cleared"
        ? await restoreReopenedCaseWithdrawals({
            reviewId,
            targetUserId: outcome.targetUserId,
            adminUserId: session.userId,
            idempotencyKey,
          })
        : "not_applicable";

  // A fraud verdict confirms that any first-seen catch-all evidence attached
  // to this case is no longer hypothetical. Promotion is replay-safe; if the
  // monitor is temporarily unavailable, retrying the same verdict repairs it.
  if (status === "flagged") {
    try {
      await promoteConfirmedCatchallDomainsForReview({
        reviewId,
        actorId: session.userId,
        actorUsername: session.username ?? undefined,
        targetUserId: outcome.targetUserId,
      });
    } catch (error) {
      // The durable flagged review is the queue. The five-minute containment
      // reconciler reconstructs and retries this promotion automatically.
      console.error("[antifraud] catch-all promotion queued for retry", {
        reviewId,
        error,
      });
    }
  }

  if (status === "in_review" || status === "cleared" || status === "flagged") {
    await syncLinkedMonitorCase({
      monitorCaseId: outcome.monitorCaseId,
      decision:
        status === "in_review"
          ? "in_review"
          : status === "cleared"
            ? "resolved_safe"
            : "resolved_fraud",
      reason:
        resolution ??
        (status === "in_review"
          ? "Account Review started."
          : `Account Review changed to ${REVIEW_STATUS_LABELS[status]}.`),
      idempotencyKey,
      actorId: session.userId,
      actorUsername: session.username ?? undefined,
    });
  }

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
  banReason: z.string().trim().max(500).optional(),
}).superRefine((value, ctx) => {
  if (value.action === "ban" && (!value.banReason || value.banReason.length < 4)) {
    ctx.addIssue({
      code: "custom",
      path: ["banReason"],
      message: "Select or write a ban reason.",
    });
  }
});

export type QuickReviewAccountAction =
  z.infer<typeof quickAccountActionSchema>["action"];

export type QuickReviewAccountActionResult = {
  /** Only ever meaningful for `fine`; every other action reports `not_applicable`. */
  withdrawalRelease: WithdrawalReleaseStatus;
};

const linkedAccountsSchema = z.object({ reviewId: uuid });

/** Lazy identity-cluster lookup for the review dialog. */
export async function fetchReviewLinkedAccounts(input: unknown): Promise<{
  accounts: FingerprintAltAccount[];
  canMassBan: boolean;
}> {
  const session = await requireAntifraudAccess();
  const parsed = linkedAccountsSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const [review] = await adminDrizzle.select({
    targetUserId: antifraud_reviews.target_user_id,
  }).from(antifraud_reviews).where(
    eq(antifraud_reviews.id, parsed.data.reviewId),
  ).limit(1);
  if (!review) throw new Error("That case no longer exists");

  const roles = new Set([session.role, ...(session.roles ?? [])]);
  return {
    accounts: await getFingerprintAltAccounts(review.targetUserId),
    canMassBan: Boolean(session.isOwner) || roles.has("admin"),
  };
}

const massBanLinkedAccountsSchema = z.object({
  reviewId: uuid,
  userIds: z.array(z.string().trim().min(1).max(100)).min(1).max(250),
  reason: z.string().trim().min(4).max(500),
  credential: z.string().trim().min(1).max(4_096),
  idempotencyKey: z.string().uuid(),
});

export type MassBanLinkedAccountsResult = {
  bannedCount: number;
  bannedUserIds: string[];
};

/**
 * Ban a staff-reviewed subset of the live identity cluster. This deliberately
 * does NOT block the shared IP/fingerprint: an operator may leave legitimate
 * household or long-standing accounts unselected, and blocking their shared
 * identifier would punish them indirectly.
 */
export async function massBanReviewLinkedAccounts(
  input: unknown,
): Promise<MassBanLinkedAccountsResult> {
  const session = await requireAntifraudManager();
  await requireCapability(session, "__can_ban_users", "mass ban linked users");
  const parsed = massBanLinkedAccountsSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  await require2FA(session.userId, parsed.data.credential);

  const replay = await adminDrizzle.execute<{
    user_ids: string[] | null;
    banned: number | null;
  }>(sql`
    SELECT metadata->'user_ids' AS user_ids,
           NULLIF(metadata->>'banned', '')::int AS banned
      FROM admin_audit_events
     WHERE event_type = 'accounts_bulk_banned'
       AND metadata->>'source' = 'antifraud_review_linked_accounts'
       AND metadata->>'idempotencyKey' = ${parsed.data.idempotencyKey}
     LIMIT 1
  `);
  const replayed = replay.rows[0];
  if (replayed) {
    return {
      bannedCount: replayed.banned ?? replayed.user_ids?.length ?? 0,
      bannedUserIds: replayed.user_ids ?? [],
    };
  }

  const [review] = await adminDrizzle.select({
    targetUserId: antifraud_reviews.target_user_id,
  }).from(antifraud_reviews).where(
    eq(antifraud_reviews.id, parsed.data.reviewId),
  ).limit(1);
  if (!review) throw new Error("That case no longer exists");

  const requestedIds = [...new Set(parsed.data.userIds)];
  const liveAccounts = await getFingerprintAltAccounts(review.targetUserId);
  const liveById = new Map(liveAccounts.map((account) => [account.id, account]));
  if (requestedIds.some((id) => !liveById.get(id)?.canBan)) {
    throw new Error(
      "The linked-account set or protection state changed. Reload and review it again.",
    );
  }

  const db = await getPrimaryDrizzleDb();
  const issuerMainUserId = await resolveAdminMainUserId(session.userId);
  const result = await db.transaction(async (tx) => {
    const updated = await tx.execute<{ id: string }>(sql`
      UPDATE "user"
         SET is_banned = TRUE,
             banned_reason = ${parsed.data.reason},
             banned_at = NOW(),
             banned_by = ${issuerMainUserId},
             updated_at = NOW()
       WHERE id = ANY(${pgArrayParam(requestedIds)}::text[])
         AND is_banned = FALSE
       RETURNING id
    `);
    if (updated.rows.length !== requestedIds.length) {
      throw new Error("One or more accounts changed while banning. Nothing was changed.");
    }
    await tx.execute(sql`
      DELETE FROM session
       WHERE "userId" = ANY(${pgArrayParam(requestedIds)}::text[])
    `);
    return updated.rows.map((row) => row.id);
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "accounts_bulk_banned",
    metadata: {
      source: "antifraud_review_linked_accounts",
      reviewId: parsed.data.reviewId,
      sourceUserId: review.targetUserId,
      reason: parsed.data.reason,
      requested: requestedIds.length,
      banned: result.length,
      user_ids: result,
      issuer_main_user_id: issuerMainUserId,
      idempotencyKey: parsed.data.idempotencyKey,
      shared_identifiers_blocked: false,
    },
  });
  revalidateTag("users-list");
  revalidateTag("users-list-stats");
  for (const userId of result) revalidateTag(userDetailTag(userId));
  revalidatePath("/antifraud/reviews");
  revalidatePath(`/antifraud/reviews/${parsed.data.reviewId}`);
  return { bannedCount: result.length, bannedUserIds: result };
}

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
  const { reviewId, action, expectedStatus, idempotencyKey, banReason } = parsed.data;

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
  if (isTerminalStatus(review.status)) {
    const intendedStatus = action === "fine" ? "cleared" : action === "ban" ? "flagged" : null;
    if (intendedStatus === review.status) {
      const replay = await updateReviewStatus({
        reviewId,
        status: intendedStatus,
        expectedStatus,
        resolution:
          intendedStatus === "cleared"
            ? "Account marked fine from Account Review."
            : `Account banned from Account Review: ${banReason}.`,
        idempotencyKey,
      });
      if (!replay.ok) throw new Error(replay.message);
      return { withdrawalRelease: replay.withdrawalRelease };
    }
    throw new Error("This case is already closed.");
  }
  if (review.status !== expectedStatus) throw new Error(STALE_CASE_MESSAGE);

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
    const reason = `Antifraud review ${reviewId}: ${banReason}`.slice(0, 500);
    let identifiers;

    try {
      identifiers = await blockKnownUserIdentifiers({
        db,
        userId: review.targetUserId,
        reason,
        actorId: session.userId,
        actorUsername: session.username ?? undefined,
      });
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
      // `blockKnownUserIdentifiers` runs before the ban transaction and is NOT
      // rolled back with it, so a failed ban can still leave IP/fingerprint
      // blocklist entries in place — entries that also hit other accounts
      // sharing those identifiers. Record the partial state durably before
      // rethrowing; otherwise this leaves no audit row at all.
      const blocklistApplied = identifiers !== undefined;
      const auditOutcome = await createAdminAuditEventDurable({
        adminUserId: session.userId,
        eventType: "antifraud_ban_partial_failure",
        targetUserId: review.targetUserId,
        metadata: {
          source: "antifraud_reviews",
          reviewId,
          reason,
          idempotencyKey,
          identifier_blocklist_applied: blocklistApplied,
          ...(identifiers
            ? {
                blacklisted_ip_count: identifiers.ipCount,
                blacklisted_fingerprint_count: identifiers.fingerprintCount,
                blocklist_changes: identifiers.changedCount,
              }
            : {}),
          error: error instanceof Error ? error.message : String(error),
        },
      });
      if (auditOutcome.status === "lost") {
        console.error(
          "[antifraud] quick review partial-ban audit lost:",
          auditOutcome.error,
        );
      }
      throw new Error(
        blocklistApplied
          ? "The account could not be banned, but its known IP/fingerprint identifiers may already be blocklisted. Nothing was hidden."
          : "The account or its known IP/fingerprint identifiers could not be banned. Nothing was hidden.",
      );
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
        case_reason: review.reason,
        issuer_main_user_id: issuerMainUserId,
        reviewId,
        idempotencyKey,
        blacklisted_ip_count: identifiers.ipCount,
        blacklisted_fingerprint_count: identifiers.fingerprintCount,
        blocklist_changes: identifiers.changedCount,
      },
    });
    revalidateTag("users-list");
    revalidateTag("users-list-stats");
    revalidateTag(userDetailTag(review.targetUserId));

    const result = await updateReviewStatus({
      reviewId,
      status: "flagged",
      expectedStatus,
      resolution: `Account banned from Account Review: ${banReason}.`,
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

const requireReviewKycSchema = z.object({
  reviewId: uuid,
  reason: z
    .string()
    .trim()
    .min(4, "Say why this account needs KYC")
    .max(500, "Keep the reason under 500 characters"),
  credential: z
    .string()
    .trim()
    .min(1, "A 2FA code or passkey is required")
    .max(4_096),
  idempotencyKey: z.string().uuid("Invalid idempotency key"),
});

export type RequireReviewKycResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Manually require KYC on the case's account from Account Review, WITHOUT
 * moving the case's status — unlike Approve/Ban, requiring KYC is additive
 * evidence gathering, not a verdict, so the case stays exactly where the
 * analyst left it.
 *
 * Delegates the actual state change to the canonical `requireAccountKyc`
 * (owner/admin gate, fresh 2FA, the withdrawals-already-locked eligibility
 * check, and the backend KYC call + its own `user_kyc_required` audit row) so
 * Account Review and the KYC workspace can never disagree about what
 * "require KYC" does or who is allowed to trigger it. This wrapper only adds
 * the case-scoped trail on top: an `account_review_kyc_required` audit row
 * and a note on the case.
 */
export async function requireReviewKyc(
  input: unknown,
): Promise<RequireReviewKycResult> {
  const session = await requireAntifraudAccess();
  const parsed = requireReviewKycSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const { reviewId, reason, credential, idempotencyKey } = parsed.data;

  const [review] = await adminDrizzle
    .select({
      targetUserId: antifraud_reviews.target_user_id,
      targetUsername: antifraud_reviews.target_username,
    })
    .from(antifraud_reviews)
    .where(eq(antifraud_reviews.id, reviewId))
    .limit(1);
  if (!review) throw new Error("That case no longer exists");

  const result = await requireAccountKyc({
    account: review.targetUserId,
    reason,
    credential,
    idempotencyKey,
  });
  if (!result.success) return { ok: false, error: result.error };

  try {
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "account_review_kyc_required",
      targetUserId: review.targetUserId,
      metadata: {
        source: "antifraud_reviews",
        reviewId,
        reason,
        idempotencyKey,
      },
    });
  } catch (error) {
    console.error("[antifraud] review kyc audit failed:", error);
  }

  try {
    await adminDrizzle.insert(antifraud_review_notes).values({
      review_id: reviewId,
      admin_user_id: session.userId,
      kind: "action",
      body: `Required KYC for ${
        review.targetUsername ?? review.targetUserId
      }.`,
    });
  } catch (error) {
    console.error("[antifraud] review kyc note failed:", error);
  }

  revalidatePath("/antifraud/reviews");
  revalidatePath(`/antifraud/reviews/${reviewId}`);
  return { ok: true };
}

const assignSchema = z.object({
  reviewId: uuid,
  /** null / "" un-assigns. */
  adminUserId: z.union([uuid, z.literal("")]).nullable().optional(),
});

const startReviewSchema = z.object({
  reviewId: uuid,
  expectedStatus: z.enum(REVIEW_STATUSES),
  idempotencyKey: z.string().uuid("Invalid idempotency key"),
});

/**
 * Open the workspace and take ownership in one guarded command. A retry with
 * the same key also retries the linked monitor transition after an upstream
 * timeout, without writing a second assignment or status note.
 */
export async function startReview(input: unknown): Promise<void> {
  const session = await requireAntifraudAccess();
  const parsed = startReviewSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const { reviewId, expectedStatus, idempotencyKey } = parsed.data;

  const outcome = await adminDrizzle.transaction(async (tx) => {
    const [current] = await tx.select({
      status: antifraud_reviews.status,
      assignedTo: antifraud_reviews.assigned_to,
      targetUserId: antifraud_reviews.target_user_id,
      metadata: antifraud_reviews.metadata,
      updatedAt: antifraud_reviews.updated_at,
    }).from(antifraud_reviews).where(eq(antifraud_reviews.id, reviewId)).limit(1);
    if (!current) throw new Error("That case no longer exists");

    const replayPredicate = and(
      eq(admin_audit_events.event_type, "antifraud_review_status_changed"),
      sql`${admin_audit_events.metadata} ->> 'idempotencyKey' = ${idempotencyKey}`,
    );
    const [replay] = await tx.select({
      adminUserId: admin_audit_events.admin_user_id,
      metadata: admin_audit_events.metadata,
    }).from(admin_audit_events).where(replayPredicate).limit(1);
    if (replay) {
      const stored = replay.metadata;
      if (
        replay.adminUserId !== session.userId ||
        !isRecord(stored) ||
        stored.reviewId !== reviewId ||
        stored.operation !== "start_review"
      ) {
        throw new Error("That review retry key was already used for a different command.");
      }
      return { monitorCaseId: monitorCaseIdFromMetadata(current.metadata), sync: true };
    }

    if (current.status === "in_review" && current.assignedTo === session.userId) {
      return { monitorCaseId: monitorCaseIdFromMetadata(current.metadata), sync: false };
    }
    if (current.status !== expectedStatus) throw new Error(STALE_CASE_MESSAGE);
    if (current.status !== "open") throw new Error("Only a new review can be started.");

    const metadata = {
      reviewId,
      from: current.status,
      to: "in_review",
      resolution: null,
      operation: "start_review",
      idempotencyKey,
    };
    const inserted = await tx.insert(admin_audit_events).values({
      admin_user_id: session.userId,
      event_type: "antifraud_review_status_changed",
      target_user_id: current.targetUserId,
      metadata,
    }).onConflictDoNothing().returning({ id: admin_audit_events.id });
    if (inserted.length === 0) throw new Error(STALE_CASE_MESSAGE);

    const updated = await tx.update(antifraud_reviews).set({
      assigned_to: session.userId,
      status: "in_review",
      updated_at: new Date().toISOString(),
    }).where(and(
      eq(antifraud_reviews.id, reviewId),
      eq(antifraud_reviews.status, current.status),
      eq(antifraud_reviews.updated_at, current.updatedAt),
      sql`${antifraud_reviews.assigned_to} IS NOT DISTINCT FROM ${current.assignedTo}::uuid`,
    )).returning({ id: antifraud_reviews.id });
    if (updated.length === 0) throw new Error(STALE_CASE_MESSAGE);

    await tx.insert(antifraud_review_notes).values({
      review_id: reviewId,
      admin_user_id: session.userId,
      kind: "status",
      body: "Picked this case up and started review.",
    });
    return { monitorCaseId: monitorCaseIdFromMetadata(current.metadata), sync: true };
  });

  if (outcome.sync) {
    await syncLinkedMonitorCase({
      monitorCaseId: outcome.monitorCaseId,
      decision: "in_review",
      reason: "Account Review started.",
      idempotencyKey,
      actorId: session.userId,
      actorUsername: session.username ?? undefined,
    });
  }
  revalidatePath("/antifraud/reviews");
  revalidatePath(`/antifraud/reviews/${reviewId}`);
}

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
      target_user_id: antifraud_reviews.target_user_id,
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

    // Same transaction as the note, so /antifraud/audit never disagrees with
    // the case timeline about who took (or handed over) a case.
    await tx.insert(admin_audit_events).values({
      admin_user_id: session.userId,
      event_type: "antifraud_review_assigned",
      target_user_id: current.target_user_id,
      metadata: {
        reviewId,
        assignedTo: assignee,
        previousAssignee: current.assigned_to,
        previousStatus: current.status,
        status: nextStatus,
      },
    });

    // Claiming a case pulls it out of every analyst's active queue the same
    // way the explicit "Postpone" button does — a case someone is already
    // working must not also sit in front of everyone else. If it isn't
    // closed before the window lapses it resurfaces in the Postponed tab.
    // Unassigning reverses that: the case belongs back in the live queue
    // immediately, not hidden behind a stale claim.
    if (assignee) {
      const dueAt = new Date(Date.now() + REVIEW_REMINDER_DELAYS_MS.postponed);
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
    } else {
      await tx.execute(sql`
        UPDATE antifraud_review_workflow
        SET postponed_until = NULL, postponed_by = NULL, updated_at = now()
        WHERE review_id = ${reviewId}::uuid
      `);
    }

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
  expectedStatus: z.enum(REVIEW_STATUSES),
  idempotencyKey: z.string().uuid("Invalid idempotency key"),
});

/** Hide a live case from active queues and schedule its reminder for 2 hours. */
export async function postponeReview(input: unknown): Promise<void> {
  const session = await requireAntifraudAccess();
  const parsed = postponeSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const { reviewId, expectedStatus, idempotencyKey } = parsed.data;

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
    if (review.status !== expectedStatus) throw new Error(STALE_CASE_MESSAGE);
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
      body: "Postponed for 2 hours. A Discord reminder is scheduled for the due time.",
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

  const [exists] = await adminDrizzle.select({
    id: antifraud_reviews.id,
    target_user_id: antifraud_reviews.target_user_id,
  })
    .from(antifraud_reviews).where(eq(antifraud_reviews.id, parsed.data.reviewId)).limit(1);
  if (!exists) throw new Error("That case no longer exists");

  // Note + audit row in one transaction, so /antifraud/audit can't miss a
  // note that the case timeline shows (or vice versa).
  await adminDrizzle.transaction(async (tx) => {
    await tx.insert(antifraud_review_notes).values({
      review_id: parsed.data.reviewId,
      admin_user_id: session.userId,
      kind: "note",
      body: parsed.data.body,
    });
    await tx.insert(admin_audit_events).values({
      admin_user_id: session.userId,
      event_type: "antifraud_review_note_added",
      target_user_id: exists.target_user_id,
      metadata: { reviewId: parsed.data.reviewId, body: parsed.data.body },
    });
  });

  revalidatePath(`/antifraud/reviews/${parsed.data.reviewId}`);
}
