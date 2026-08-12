"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { adminDrizzle } from "@/lib/admin-db";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { getUserFeatureLocks, updateUserRewardLocks } from "@/lib/backend-api/feature-locks";
import { reward_abuse_reviews } from "@/lib/db-schema/admin/schema";
import { requireAntifraudAccess } from "@/lib/require-antifraud-access";
import { requireCapability } from "@/lib/require-capability";

const DecisionSchema = z.object({
  reviewId: z.string().uuid("Invalid review"),
  decision: z.enum(["confirm", "dismiss"]),
  reason: z.string().trim().min(3, "Add a short review note").max(500),
});

export type RewardAbuseDecisionResult =
  | { ok: true; status: "confirmed" | "dismissed"; rainLocked: boolean }
  | { ok: false; message: string };

export async function decideRewardAbuseReview(
  input: unknown,
): Promise<RewardAbuseDecisionResult> {
  const session = await requireAntifraudAccess();
  const parsed = DecisionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid decision" };
  }
  const { reviewId, decision, reason } = parsed.data;
  const [review] = await adminDrizzle.select({
    id: reward_abuse_reviews.id,
    userId: reward_abuse_reviews.target_user_id,
    status: reward_abuse_reviews.status,
    rainLockApplied: reward_abuse_reviews.rain_lock_applied,
  }).from(reward_abuse_reviews).where(eq(reward_abuse_reviews.id, reviewId)).limit(1);
  if (!review) return { ok: false, message: "Review not found" };

  const targetStatus = decision === "confirm" ? "confirmed" : "dismissed";
  if (review.status !== "pending") {
    if (review.status === targetStatus) {
      return { ok: true, status: targetStatus, rainLocked: review.rainLockApplied };
    }
    return { ok: false, message: "Another staff member already decided this review." };
  }

  let rainLocked = false;
  if (decision === "confirm") {
    await requireCapability(
      session,
      "__can_toggle_feature_locks",
      "disable Rain rewards after confirming abuse",
    );
    try {
      const current = await getUserFeatureLocks(review.userId);
      const categories = [...new Set([...current.locked_reward_categories, "rain" as const])];
      const updated = await updateUserRewardLocks(
        review.userId,
        categories,
        session.userId,
        `Confirmed rain reward abuse: ${reason}`,
      );
      rainLocked = updated.locked_reward_categories.includes("rain");
      if (!rainLocked) throw new Error("Backend did not confirm the Rain lock");
    } catch (error) {
      console.error("[reward-abuse] Rain lock failed", error);
      return {
        ok: false,
        message: "Rain access could not be disabled, so the review was left pending. Try again.",
      };
    }
  }

  const updated = await adminDrizzle.update(reward_abuse_reviews).set({
    status: targetStatus,
    reviewed_by: session.userId,
    review_reason: reason,
    reviewed_at: sql`now()`,
    rain_lock_applied: rainLocked,
    updated_at: sql`now()`,
  }).where(and(
    eq(reward_abuse_reviews.id, reviewId),
    eq(reward_abuse_reviews.status, "pending"),
  )).returning({ id: reward_abuse_reviews.id });
  if (updated.length !== 1) {
    return { ok: false, message: "Another staff member already decided this review." };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: decision === "confirm"
      ? "reward_abuse_confirmed_rain_locked"
      : "reward_abuse_dismissed",
    targetUserId: review.userId,
    metadata: { reviewId, reason, rainLocked },
  });
  revalidatePath("/antifraud/reward-abuse");
  revalidateTag(`users-detail-${review.userId}`);
  return { ok: true, status: targetStatus, rainLocked };
}
