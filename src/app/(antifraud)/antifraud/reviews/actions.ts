"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import {
  admin_users,
  antifraud_review_notes,
  antifraud_reviews,
} from "@/lib/db-schema/admin/schema";
import { requireAntifraudAccess } from "@/lib/require-antifraud-access";
import { createAdminAuditEvent } from "@/lib/admin-audit";
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
  // surface the existing one instead of failing with a uniqueness error.
  const [live] = await adminDrizzle.select({ id: antifraud_reviews.id })
    .from(antifraud_reviews).where(and(
      eq(antifraud_reviews.target_user_id, targetUserId),
      inArray(antifraud_reviews.status, ["open", "in_review"]),
    )).limit(1);
  if (live) {
    throw new Error(
      "That account already has an open case — open it from the queue instead.",
    );
  }

  const [created] = await adminDrizzle.insert(antifraud_reviews).values({
      target_user_id: targetUserId,
      target_username: targetUsername ? targetUsername : null,
      status: "open",
      severity,
      source: "manual",
      reason,
      opened_by: session.userId,
    }).returning({ id: antifraud_reviews.id });
  if (!created) throw new Error("Review insert returned no row");

  await adminDrizzle.insert(antifraud_review_notes).values({
      review_id: created.id,
      admin_user_id: session.userId,
      kind: "status",
      body: `Case opened (${severity}).`,
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

  const [current] = await adminDrizzle.select({
    status: antifraud_reviews.status, target_user_id: antifraud_reviews.target_user_id,
    assigned_to: antifraud_reviews.assigned_to,
    opened_by: antifraud_reviews.opened_by,
  }).from(antifraud_reviews).where(eq(antifraud_reviews.id, reviewId)).limit(1);
  if (!current) throw new Error("That case no longer exists");
  if (current.status === status && !resolution) return;

  const isTerminal = status === "cleared" || status === "flagged";
  await adminDrizzle.update(antifraud_reviews).set({
      status,
      resolution: resolution ? resolution : isTerminal ? null : undefined,
      resolved_by: isTerminal ? session.userId : null,
      resolved_at: isTerminal ? new Date().toISOString() : null,
    }).where(eq(antifraud_reviews.id, reviewId));

  await adminDrizzle.insert(antifraud_review_notes).values({
      review_id: reviewId,
      admin_user_id: session.userId,
      kind: "status",
      body: resolution
        ? `${REVIEW_STATUS_LABELS[status]} — ${resolution}`
        : `Status changed to ${REVIEW_STATUS_LABELS[status]}.`,
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

  const [current] = await adminDrizzle.select({
    assigned_to: antifraud_reviews.assigned_to, status: antifraud_reviews.status,
    reason: antifraud_reviews.reason,
  }).from(antifraud_reviews).where(eq(antifraud_reviews.id, reviewId)).limit(1);
  if (!current) throw new Error("That case no longer exists");
  if (current.assigned_to === assignee) return;

  if (assignee) {
    // Guard against assigning to somebody who isn't a real, active admin.
    const [target] = await adminDrizzle.select({ is_active: admin_users.is_active })
      .from(admin_users).where(eq(admin_users.id, assignee)).limit(1);
    if (!target?.is_active) throw new Error("That admin account isn't active");
  }

  await adminDrizzle.update(antifraud_reviews).set({
      assigned_to: assignee,
      // Picking a case up moves it out of the untouched "open" bucket.
      status: assignee && current.status === "open" ? "in_review" : undefined,
    }).where(eq(antifraud_reviews.id, reviewId));

  await adminDrizzle.insert(antifraud_review_notes).values({
      review_id: reviewId,
      admin_user_id: session.userId,
      kind: "assign",
      body: assignee
        ? assignee === session.userId
          ? "Picked this case up."
          : "Assigned this case to another analyst."
        : "Unassigned this case.",
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

/** Re-grade a case's severity. */
export async function updateReviewSeverity(input: unknown): Promise<void> {
  const session = await requireAntifraudAccess();
  const parsed = severitySchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);

  const [current] = await adminDrizzle.select({ severity: antifraud_reviews.severity })
    .from(antifraud_reviews).where(eq(antifraud_reviews.id, parsed.data.reviewId)).limit(1);
  if (!current) throw new Error("That case no longer exists");
  if (current.severity === parsed.data.severity) return;

  await adminDrizzle.update(antifraud_reviews).set({ severity: parsed.data.severity })
    .where(eq(antifraud_reviews.id, parsed.data.reviewId));

  await adminDrizzle.insert(antifraud_review_notes).values({
      review_id: parsed.data.reviewId,
      admin_user_id: session.userId,
      kind: "status",
      body: `Severity changed ${current.severity} → ${parsed.data.severity}.`,
  });

  revalidatePath(`/antifraud/reviews/${parsed.data.reviewId}`);
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
