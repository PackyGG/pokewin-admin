"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { adminDb } from "@/lib/admin-db";
import { requireAntifraudAccess } from "@/lib/require-antifraud-access";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { notifyStaff } from "@/lib/antifraud/notifications";
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

/** Manually open a case on an account. */
export async function openReview(input: unknown): Promise<{ id: string }> {
  const session = await requireAntifraudAccess();
  const parsed = openReviewSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const { targetUserId, targetUsername, severity, reason } = parsed.data;

  // One live case per account (enforced by the partial unique index too) —
  // surface the existing one instead of failing with a Prisma error.
  const live = await adminDb.antifraud_reviews.findFirst({
    where: {
      target_user_id: targetUserId,
      status: { in: ["open", "in_review"] },
    },
    select: { id: true },
  });
  if (live) {
    throw new Error(
      "That account already has an open case — open it from the queue instead.",
    );
  }

  const created = await adminDb.antifraud_reviews.create({
    data: {
      target_user_id: targetUserId,
      target_username: targetUsername ? targetUsername : null,
      status: "open",
      severity,
      source: "manual",
      reason,
      opened_by: session.userId,
    },
    select: { id: true },
  });

  await adminDb.antifraud_review_notes.create({
    data: {
      review_id: created.id,
      admin_user_id: session.userId,
      kind: "status",
      body: `Case opened (${severity}).`,
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "antifraud_review_opened",
    targetUserId,
    metadata: { reviewId: created.id, severity, reason },
  });

  revalidatePath("/antifraud/reviews");
  revalidatePath("/antifraud");
  return { id: created.id };
}

const updateStatusSchema = z.object({
  reviewId: uuid,
  status: z.enum(REVIEW_STATUSES),
  resolution: z
    .string()
    .trim()
    .max(500, "Keep the note under 500 characters")
    .optional()
    .or(z.literal("")),
});

/**
 * Move a case along. Setting a terminal status (cleared / flagged) stamps the
 * resolver + timestamp and bumps that analyst's `reviews_resolved` counter;
 * re-opening clears them again so the counters can't inflate on a flip-flop.
 */
export async function updateReviewStatus(input: unknown): Promise<void> {
  const session = await requireAntifraudAccess();
  const parsed = updateStatusSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const { reviewId, status, resolution } = parsed.data;

  const current = await adminDb.antifraud_reviews.findUnique({
    where: { id: reviewId },
    select: {
      status: true,
      target_user_id: true,
      opened_by: true,
      assigned_to: true,
      resolved_by: true,
    },
  });
  if (!current) throw new Error("That case no longer exists");
  if (current.status === status && !resolution) return;

  const isTerminal = status === "cleared" || status === "flagged";
  const wasTerminal =
    current.status === "cleared" || current.status === "flagged";

  await adminDb.antifraud_reviews.update({
    where: { id: reviewId },
    data: {
      status,
      resolution: resolution ? resolution : isTerminal ? null : undefined,
      resolved_by: isTerminal ? session.userId : null,
      resolved_at: isTerminal ? new Date() : null,
    },
  });

  // Counter bookkeeping — only on the transition INTO a terminal state, and
  // only ever for the person who actually closed it.
  if (isTerminal && !wasTerminal) {
    await adminDb.staff_profiles
      .update({
        where: { admin_user_id: session.userId },
        data: { reviews_resolved: { increment: 1 } },
      })
      .catch(() => {
        // No profile row yet (or tables not provisioned) — the counter is a
        // convenience, never a reason to fail closing a case.
      });
  } else if (!isTerminal && wasTerminal && current.resolved_by) {
    await adminDb.staff_profiles
      .update({
        where: { admin_user_id: current.resolved_by },
        data: { reviews_resolved: { decrement: 1 } },
      })
      .catch(() => {});
  }

  await adminDb.antifraud_review_notes.create({
    data: {
      review_id: reviewId,
      admin_user_id: session.userId,
      kind: "status",
      body: resolution
        ? `${REVIEW_STATUS_LABELS[status]} — ${resolution}`
        : `Status changed to ${REVIEW_STATUS_LABELS[status]}.`,
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "antifraud_review_status_changed",
    targetUserId: current.target_user_id,
    metadata: {
      reviewId,
      from: current.status,
      to: status,
      resolution: resolution || undefined,
    },
  });

  // Tell the case's opener how it ended (unless they closed it themselves).
  if (isTerminal && current.opened_by && current.opened_by !== session.userId) {
    await notifyStaff({
      recipients: [current.opened_by],
      kind: "review_resolved",
      title: `Case ${REVIEW_STATUS_LABELS[status].toLowerCase()}`,
      body: resolution || `A case you opened was marked ${status}.`,
      href: `/antifraud/reviews/${reviewId}`,
      metadata: { reviewId, status },
    });
  }

  revalidatePath("/antifraud/reviews");
  revalidatePath(`/antifraud/reviews/${reviewId}`);
  revalidatePath("/antifraud");
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

  const current = await adminDb.antifraud_reviews.findUnique({
    where: { id: reviewId },
    select: { assigned_to: true, status: true, target_user_id: true, reason: true },
  });
  if (!current) throw new Error("That case no longer exists");
  if (current.assigned_to === assignee) return;

  if (assignee) {
    // Guard against assigning to somebody who isn't a real, active admin.
    const target = await adminDb.admin_users.findUnique({
      where: { id: assignee },
      select: { is_active: true },
    });
    if (!target?.is_active) throw new Error("That admin account isn't active");
  }

  await adminDb.antifraud_reviews.update({
    where: { id: reviewId },
    data: {
      assigned_to: assignee,
      // Picking a case up moves it out of the untouched "open" bucket.
      status: assignee && current.status === "open" ? "in_review" : undefined,
    },
  });

  await adminDb.antifraud_review_notes.create({
    data: {
      review_id: reviewId,
      admin_user_id: session.userId,
      kind: "assign",
      body: assignee
        ? assignee === session.userId
          ? "Picked this case up."
          : "Assigned this case to another analyst."
        : "Unassigned this case.",
    },
  });

  if (assignee && assignee !== session.userId) {
    await notifyStaff({
      recipients: [assignee],
      kind: "review_assigned",
      title: "A case was assigned to you",
      body: current.reason,
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

  const exists = await adminDb.antifraud_reviews.findUnique({
    where: { id: parsed.data.reviewId },
    select: { id: true },
  });
  if (!exists) throw new Error("That case no longer exists");

  await adminDb.antifraud_review_notes.create({
    data: {
      review_id: parsed.data.reviewId,
      admin_user_id: session.userId,
      kind: "note",
      body: parsed.data.body,
    },
  });

  revalidatePath(`/antifraud/reviews/${parsed.data.reviewId}`);
}

const severitySchema = z.object({
  reviewId: uuid,
  severity: z.enum(REVIEW_SEVERITIES),
});

/** Re-grade a case's severity. */
export async function updateReviewSeverity(input: unknown): Promise<void> {
  const session = await requireAntifraudAccess();
  const parsed = severitySchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);

  const current = await adminDb.antifraud_reviews.findUnique({
    where: { id: parsed.data.reviewId },
    select: { severity: true },
  });
  if (!current) throw new Error("That case no longer exists");
  if (current.severity === parsed.data.severity) return;

  await adminDb.antifraud_reviews.update({
    where: { id: parsed.data.reviewId },
    data: { severity: parsed.data.severity },
  });

  await adminDb.antifraud_review_notes.create({
    data: {
      review_id: parsed.data.reviewId,
      admin_user_id: session.userId,
      kind: "status",
      body: `Severity changed ${current.severity} → ${parsed.data.severity}.`,
    },
  });

  revalidatePath(`/antifraud/reviews/${parsed.data.reviewId}`);
  revalidatePath("/antifraud/reviews");
}

/** Assignable analysts — everyone with a staff profile who is still active. */
export async function listAssignableAnalysts(): Promise<
  { id: string; label: string }[]
> {
  await requireAntifraudAccess();
  try {
    const profiles = await adminDb.staff_profiles.findMany({
      select: { admin_user_id: true },
    });
    if (profiles.length === 0) return [];
    const users = await adminDb.admin_users.findMany({
      where: {
        id: { in: profiles.map((p) => p.admin_user_id) },
        is_active: true,
      },
      select: { id: true, username: true, display_username: true },
      orderBy: { username: "asc" },
    });
    return users.map((u) => ({
      id: u.id,
      label: u.display_username ?? u.username,
    }));
  } catch {
    return [];
  }
}
