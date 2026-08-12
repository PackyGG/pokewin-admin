"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { adminDrizzle } from "@/lib/admin-db";
import { createAdminAuditEventDurable } from "@/lib/admin-audit";
import { confirmRainRewardAbuse } from "@/lib/backend-api/feature-locks";
import { reward_abuse_reviews } from "@/lib/db-schema/admin/schema";
import { requireAntifraudAccess } from "@/lib/require-antifraud-access";
import { requireCapability } from "@/lib/require-capability";

const DecisionSchema = z.object({
  reviewId: z.string().uuid("Invalid review"),
  decision: z.enum(["confirm", "dismiss"]),
  reason: z.string().trim().min(3, "Add a short review note").max(500),
});

export type RewardAbuseDecisionResult =
  | { ok: true; status: "confirmed" | "dismissed"; rainLocked: boolean; rainFundsRemovedUsd: number }
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
  const targetStatus = decision === "confirm" ? "confirmed" : "dismissed";
  if (decision === "confirm") {
    await requireCapability(
      session,
      "__can_toggle_feature_locks",
      "disable Rain rewards after confirming abuse",
    );
  }

  const outcome = await adminDrizzle.transaction(async (tx) => {
    // Serialize staff decisions for this review across the backend money call.
    // A concurrent dismiss cannot win after the Rain lock/forfeit commits.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${reviewId}, 0))`);
    const [review] = await tx.select({
      id: reward_abuse_reviews.id,
      userId: reward_abuse_reviews.target_user_id,
      status: reward_abuse_reviews.status,
      rainLockApplied: reward_abuse_reviews.rain_lock_applied,
      rainFundsRemovedUsd: reward_abuse_reviews.rain_funds_removed_usd,
      metrics: reward_abuse_reviews.metrics,
    }).from(reward_abuse_reviews).where(eq(reward_abuse_reviews.id, reviewId)).limit(1);
    if (!review) return { result: { ok: false, message: "Review not found" } as const };
    if (review.status !== "pending") {
      if (review.status === targetStatus) {
        return {
          result: {
            ok: true,
            status: targetStatus,
            rainLocked: review.rainLockApplied,
            rainFundsRemovedUsd: Number(review.rainFundsRemovedUsd),
          } as const,
        };
      }
      return {
        result: {
          ok: false,
          message: "Another staff member already decided this review.",
        } as const,
      };
    }

    let rainLocked = false;
    let rainFundsRemovedUsd = 0;
    let rainForfeitLedgerTxId: string | null = null;
    if (decision === "confirm") {
      const metrics = review.metrics as { netRainUsd?: unknown };
      const maxRainAmountUsd = Number(metrics?.netRainUsd);
      if (!Number.isFinite(maxRainAmountUsd) || maxRainAmountUsd < 0) {
        throw new Error("Review has invalid Rain evidence");
      }
      const updated = await confirmRainRewardAbuse(
        review.userId,
        { reviewId, maxRainAmountUsd, reason },
        session.userId,
      );
      rainLocked = updated.locked_reward_categories.includes("rain");
      rainFundsRemovedUsd = updated.removed_usd;
      rainForfeitLedgerTxId = updated.ledger_transaction_id;
      if (!rainLocked) throw new Error("Backend did not confirm the Rain lock");
    }

    await tx.update(reward_abuse_reviews).set({
      status: targetStatus,
      reviewed_by: session.userId,
      review_reason: reason,
      reviewed_at: sql`now()`,
      rain_lock_applied: rainLocked,
      rain_funds_removed_usd: String(rainFundsRemovedUsd),
      rain_forfeit_ledger_tx_id: rainForfeitLedgerTxId,
      updated_at: sql`now()`,
    }).where(eq(reward_abuse_reviews.id, reviewId));
    return {
      result: { ok: true, status: targetStatus, rainLocked, rainFundsRemovedUsd } as const,
      audit: { userId: review.userId, rainLocked, rainFundsRemovedUsd, rainForfeitLedgerTxId },
    };
  }).catch((error) => {
    console.error("[reward-abuse] Rain confirmation failed", error);
    return {
      result: {
        ok: false,
        message: "Rain access or attributable balance could not be updated, so the review was left pending. Try again.",
      } as const,
    };
  });

  if (!outcome.result.ok || !("audit" in outcome) || !outcome.audit) {
    return outcome.result;
  }

  await createAdminAuditEventDurable({
    adminUserId: session.userId,
    eventType: decision === "confirm"
      ? "reward_abuse_confirmed_rain_locked"
      : "reward_abuse_dismissed",
    targetUserId: outcome.audit.userId,
    metadata: {
      reviewId,
      reason,
      rainLocked: outcome.audit.rainLocked,
      rainFundsRemovedUsd: outcome.audit.rainFundsRemovedUsd,
      rainForfeitLedgerTxId: outcome.audit.rainForfeitLedgerTxId,
    },
  });
  revalidatePath("/antifraud/reward-abuse");
  revalidateTag(`users-detail-${outcome.audit.userId}`);
  return outcome.result;
}
