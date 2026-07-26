"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq, inArray, ne, sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import {
  admin_audit_events,
  admin_users,
  antifraud_review_notes,
  antifraud_reviews,
  staff_profiles,
} from "@/lib/db-schema/admin/schema";
import { requireAntifraudAccess } from "@/lib/require-antifraud-access";
import { isPostgresError } from "@/lib/postgres-errors";
import { notifyStaff } from "@/lib/staff/notifications";
import {
  REVIEW_SEVERITIES,
  REVIEW_STATUSES,
  REVIEW_STATUS_LABELS,
} from "@/lib/antifraud/reviews";

/**
 * Account-review mutations.
 *
 * WHAT THESE DO NOT DO: touch the MAIN (prod game) DB. A review is the fraud
 * team's working record — banning an account, adjusting a balance or wiping a
 * user still happens on the existing, separately-audited admin surfaces. That
 * boundary is deliberate: it keeps this whole workspace additive and keeps the
 * prod DB read-only, exactly as the project rules require.
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
 * `OPEN_REVIEW_STATUSES` (which also contains 'escalated' and describes the
 * queue's "needs work" filter): if these two ever drift, the pre-check stops
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
  severity: z.enum(REVIEW_SEVERITIES),
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
  const { targetUserId, targetUsername, severity, reason } = parsed.data;

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
        severity,
        source: "manual",
        reason,
        opened_by: session.userId,
      }).returning({ id: antifraud_reviews.id });
      if (!created) throw new Error("Review insert returned no row");

      await tx.insert(antifraud_review_notes).values({
        review_id: created.id,
        admin_user_id: session.userId,
        kind: "status",
        body: `Case opened (${severity}).`,
      });

      await tx.insert(admin_audit_events).values({
        admin_user_id: session.userId,
        event_type: "antifraud_review_opened",
        target_user_id: targetUserId,
        metadata: { reviewId: created.id, severity, reason },
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

export type UpdateReviewStatusResult =
  | { ok: true }
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
 * Move a case along. Setting a terminal status (cleared / flagged) stamps the
 * resolver + timestamp and stores the written conclusion; any NON-terminal
 * transition (re-opening, escalating) clears resolver, timestamp AND the
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
    | { kind: "replayed" }
    | { kind: "applied"; applied: Applied }
    | { kind: "conflict"; conflictReviewId: string | null };

  const runTransaction = async (): Promise<Outcome> =>
    adminDrizzle.transaction(async (tx): Promise<Outcome> => {
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
        return { kind: "replayed" };
      }

      const [current] = await tx.select({
        status: antifraud_reviews.status,
        target_user_id: antifraud_reviews.target_user_id,
        opened_by: antifraud_reviews.opened_by,
        resolved_by: antifraud_reviews.resolved_by,
        updated_at: antifraud_reviews.updated_at,
      }).from(antifraud_reviews).where(eq(antifraud_reviews.id, reviewId)).limit(1);
      if (!current) throw new Error("That case no longer exists");

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
        return { kind: "replayed" };
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
  if (outcome.kind === "noop") return { ok: true };
  if (outcome.kind === "replayed") {
    // A previous response may have failed during cache invalidation after the
    // transaction committed. Re-run only the safe post-commit step.
    revalidatePath("/antifraud/reviews");
    revalidatePath(`/antifraud/reviews/${reviewId}`);
    revalidatePath("/antifraud");
    return { ok: true };
  }

  const { openedBy } = outcome.applied;

  if (isTerminal && openedBy && openedBy !== session.userId) {
    try {
      await notifyStaff({
        recipients: [openedBy],
        kind: "review_resolved",
        title: `Case ${REVIEW_STATUS_LABELS[status].toLowerCase()}`,
        body: resolution || `A case you opened was marked ${status}.`,
        href: `/antifraud/reviews/${reviewId}`,
        metadata: { reviewId, status },
      });
    } catch (err) {
      // The standing verdict, note, counter and audit are already atomic. A
      // notification transport failure must not make the client retry them.
      console.error("[antifraud] review resolved notification failed:", err);
    }
  }

  revalidatePath("/antifraud/reviews");
  revalidatePath(`/antifraud/reviews/${reviewId}`);
  revalidatePath("/antifraud");
  return { ok: true };
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
    // Guard against assigning to somebody who isn't a real, active admin.
    const [target] = await adminDrizzle.select({ is_active: admin_users.is_active })
      .from(admin_users).where(eq(admin_users.id, assignee)).limit(1);
    if (!target?.is_active) throw new Error("That admin account isn't active");
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

  if (assignee && assignee !== session.userId) {
    await notifyStaff({
      recipients: [assignee],
      kind: "review_assigned",
      title: "A case was assigned to you",
      body: applied.reason,
      href: `/antifraud/reviews/${reviewId}`,
      metadata: { reviewId },
    });
  }

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

const severitySchema = z.object({
  reviewId: uuid,
  severity: z.enum(REVIEW_SEVERITIES),
});

/** Re-grade a case's severity. Same guarded, transactional shape. */
export async function updateReviewSeverity(input: unknown): Promise<void> {
  const session = await requireAntifraudAccess();
  const parsed = severitySchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const { reviewId, severity } = parsed.data;

  const applied = await adminDrizzle.transaction(async (tx) => {
    const [current] = await tx.select({ severity: antifraud_reviews.severity })
      .from(antifraud_reviews).where(eq(antifraud_reviews.id, reviewId)).limit(1);
    if (!current) throw new Error("That case no longer exists");
    if (current.severity === severity) return false;

    const updated = await tx.update(antifraud_reviews).set({
      severity,
      updated_at: new Date().toISOString(),
    }).where(and(
      eq(antifraud_reviews.id, reviewId),
      eq(antifraud_reviews.severity, current.severity),
    )).returning({ id: antifraud_reviews.id });
    if (updated.length === 0) throw new Error(STALE_CASE_MESSAGE);

    await tx.insert(antifraud_review_notes).values({
      review_id: reviewId,
      admin_user_id: session.userId,
      kind: "status",
      body: `Severity changed ${current.severity} → ${severity}.`,
    });
    return true;
  });
  if (!applied) return;

  revalidatePath(`/antifraud/reviews/${reviewId}`);
  revalidatePath("/antifraud/reviews");
}

/** Assignable analysts — active admin or support accounts. */
export async function listAssignableAnalysts(): Promise<
  { id: string; label: string }[]
> {
  await requireAntifraudAccess();
  try {
    const users = await adminDrizzle.select({
      id: admin_users.id, username: admin_users.username,
      display_username: admin_users.display_username,
      role: admin_users.role, roles: admin_users.roles,
    }).from(admin_users).where(eq(admin_users.is_active, true))
      .orderBy(admin_users.username).limit(200);
    return users.filter(
      (user) =>
        user.role === "admin" ||
        user.role === "support" ||
        user.roles.includes("admin") ||
        user.roles.includes("support"),
    ).map((u) => ({
      id: u.id,
      label: u.display_username ?? u.username,
    }));
  } catch {
    return [];
  }
}
