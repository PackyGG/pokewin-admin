"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { adminDrizzle } from "@/lib/admin-db";
import { createAdminAuditEventDurable } from "@/lib/admin-audit";
import {
  getUserFeatureLocks,
  updateUserRewardLocks,
} from "@/lib/backend-api/feature-locks";
import { reward_abuse_reviews } from "@/lib/db-schema/admin/schema";
import { getPrimaryDrizzleDb } from "@/lib/db";
import { require2FA } from "@/lib/require-2fa";
import { requireAntifraudAccess } from "@/lib/require-antifraud-access";
import { requireCapability } from "@/lib/require-capability";

const DecisionSchema = z.object({
  reviewId: z.string().uuid("Invalid review"),
  decision: z.enum(["confirm", "dismiss"]),
  reason: z.string().trim().min(3, "Add a short review note").max(500),
  credential: z.string().trim().optional(),
}).superRefine((value, ctx) => {
  if (value.decision === "confirm" && !value.credential) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["credential"],
      message: "A 2FA code or passkey is required",
    });
  }
});

export type RewardAbuseDecisionResult =
  | { ok: true; status: "confirmed" | "dismissed"; rainLocked: boolean; rainFundsRemovedUsd: number }
  | { ok: false; message: string };

type RainForfeitResult = {
  removedUsd: number;
  ledgerTransactionId: string;
};

function usdCents(value: unknown): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("Review has invalid Rain evidence");
  }
  return Math.max(0, Math.round(amount * 100));
}

/**
 * Idempotently removes only the portion of the live available balance that is
 * simultaneously covered by this review's net Rain evidence and MAIN's
 * general-bonus provenance counter. Rain currently shares `bonus_other` with
 * a few other reward sources, so this is a conservative cap, not exact
 * source-lot accounting.
 *
 * The immutable external marker is the cross-database recovery boundary. If
 * MAIN commits but the reward-lock call or Admin transaction later fails, a
 * retry returns the original ledger outcome and never debits the balance a
 * second time.
 */
async function forfeitRainAttributableBalance(input: {
  reviewId: string;
  userId: string;
  maxRainAmountUsd: number;
  reason: string;
}): Promise<RainForfeitResult> {
  const db = await getPrimaryDrizzleDb();
  const marker = `reward-abuse:${input.reviewId}:rain`;
  const requestedCents = usdCents(input.maxRainAmountUsd);

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${marker}, 0))`,
    );

    const existing = (await tx.execute<{
      id: string;
      user_id: string;
      type: string;
      status: string;
      amount: string;
      metadata: Record<string, unknown> | null;
    }>(sql`
      SELECT id::text, user_id, type::text, status::text, amount::text, metadata
      FROM ledger_transactions
      WHERE external_tx_id = ${marker}
      LIMIT 1
    `)).rows[0];
    if (existing) {
      const existingAmount = Number(existing.amount);
      if (
        existing.user_id !== input.userId ||
        existing.type !== "admin_balance_adjustment" ||
        existing.status !== "completed" ||
        existingAmount > 0 ||
        existing.metadata?.adjustment_category !== "fraud_abuse" ||
        existing.metadata?.kind !== "reward_abuse_rain_forfeit" ||
        existing.metadata?.review_id !== input.reviewId ||
        Number(existing.metadata?.requested_usd) !== requestedCents / 100
      ) {
        throw new Error("Existing Rain forfeiture marker conflicts with this review");
      }
      const removedCents = Math.max(0, Math.round(Math.abs(existingAmount) * 100));
      if (!Number.isFinite(removedCents)) {
        throw new Error("Existing Rain forfeiture ledger amount is invalid");
      }
      return {
        removedUsd: removedCents / 100,
        ledgerTransactionId: existing.id,
      };
    }

    const balance = (await tx.execute<{
      id: string;
      available_balance: string;
      unwagered_bonus_other_usd: string;
    }>(sql`
      SELECT id::text, available_balance::text,
        unwagered_bonus_other_usd::text
      FROM balances
      WHERE user_id = ${input.userId}
      FOR UPDATE
    `)).rows[0];
    if (!balance) throw new Error("User balance not found");

    const availableCents = usdCents(balance.available_balance);
    const bonusOtherCents = usdCents(balance.unwagered_bonus_other_usd);
    const removedCents = Math.min(
      requestedCents,
      availableCents,
      bonusOtherCents,
    );
    const removedUsd = removedCents / 100;
    const balanceBeforeUsd = availableCents / 100;
    const balanceAfterUsd = (availableCents - removedCents) / 100;
    const ledgerTransactionId = crypto.randomUUID();

    const updated = await tx.execute<{ id: string }>(sql`
      UPDATE balances
      SET
        available_balance = GREATEST(
          available_balance::numeric - ${removedUsd}::numeric,
          0
        ),
        unwagered_bonus_other_usd = GREATEST(
          unwagered_bonus_other_usd::numeric - ${removedUsd}::numeric,
          0
        ),
        version = version + 1,
        updated_at = now()
      WHERE id = ${balance.id}::uuid
        AND available_balance::numeric >= ${removedUsd}::numeric
        AND unwagered_bonus_other_usd::numeric >= ${removedUsd}::numeric
      RETURNING id::text
    `);
    if (updated.rows.length !== 1) {
      throw new Error("Rain forfeiture balance changed concurrently");
    }

    await tx.execute(sql`
      INSERT INTO ledger_transactions (
        id, user_id, type, amount, balance_before, balance_after,
        external_tx_id, description, metadata, status
      ) VALUES (
        ${ledgerTransactionId}::uuid,
        ${input.userId},
        'admin_balance_adjustment',
        ${-removedUsd}::numeric,
        ${balanceBeforeUsd}::numeric,
        ${balanceAfterUsd}::numeric,
        ${marker},
        ${`Rain reward-abuse forfeiture: ${input.reason}`},
        ${JSON.stringify({
          adjustment_category: "fraud_abuse",
          kind: "reward_abuse_rain_forfeit",
          review_id: input.reviewId,
          requested_usd: requestedCents / 100,
          removed_usd: removedUsd,
          attribution: "bonus_other_capped",
        })}::jsonb,
        'completed'
      )
    `);

    return { removedUsd, ledgerTransactionId };
  });
}

async function hasRainForfeitMarker(reviewId: string): Promise<boolean> {
  const db = await getPrimaryDrizzleDb();
  const marker = `reward-abuse:${reviewId}:rain`;
  const row = (await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1
      FROM ledger_transactions
      WHERE external_tx_id = ${marker}
    ) AS exists
  `)).rows[0];
  return row?.exists === true;
}

export async function decideRewardAbuseReview(
  input: unknown,
): Promise<RewardAbuseDecisionResult> {
  const session = await requireAntifraudAccess();
  const parsed = DecisionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid decision" };
  }
  const { reviewId, decision, reason, credential } = parsed.data;
  const targetStatus = decision === "confirm" ? "confirmed" : "dismissed";
  if (decision === "confirm") {
    try {
      await Promise.all([
        requireCapability(
        session,
        "__can_toggle_feature_locks",
        "lock Rain, tips, and sponsored battles after confirming abuse",
        ),
        requireCapability(
          session,
          "__can_adjust_balance",
          "remove Rain-attributable balance after confirming abuse",
        ),
      ]);
      // Confirmation changes both money and reward access. Authenticate the
      // operator before either external side effect can begin.
      await require2FA(session.userId, credential ?? "");
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error
          ? error.message
          : "Confirmation authorization failed",
      };
    }
  }

  const outcome = await adminDrizzle.transaction(async (tx) => {
    // Serialize staff decisions for this review across the balance and lock calls.
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

    // MAIN is the durable cross-database recovery boundary. If a previous
    // confirmation debited (or deliberately recorded a $0 forfeiture) but
    // the later reward-lock/Admin write failed, this review must stay on the
    // confirmation recovery path and can never be dismissed as unchanged.
    if (decision === "dismiss" && await hasRainForfeitMarker(reviewId)) {
      return {
        result: {
          ok: false,
          message: "Rain funds were already processed for this review. Confirm it again to finish applying the reward locks.",
        } as const,
      };
    }

    let rainLocked = false;
    let rainFundsRemovedUsd = 0;
    let rainForfeitLedgerTxId: string | null = null;
    if (decision === "confirm") {
      const metrics = review.metrics as { netRainUsd?: unknown };
      const maxRainAmountUsd = Number(metrics?.netRainUsd);
      const forfeit = await forfeitRainAttributableBalance({
        reviewId,
        userId: review.userId,
        maxRainAmountUsd,
        reason,
      });
      rainFundsRemovedUsd = forfeit.removedUsd;
      rainForfeitLedgerTxId = forfeit.ledgerTransactionId;

      // The deployed backend exposes a replacement-style reward-lock API.
      // Preserve all currently locked categories and add every reward surface
      // covered by a confirmed Rain-abuse finding.
      const current = await getUserFeatureLocks(review.userId);
      const categories = [...new Set([
        ...current.locked_reward_categories,
        "rain" as const,
        "tips" as const,
        "sponsored_battles" as const,
      ])];
      const updated = await updateUserRewardLocks(
        review.userId,
        categories,
        session.userId,
        `Confirmed rain reward abuse: ${reason}`,
      );
      const requiredLocks = ["rain", "tips", "sponsored_battles"] as const;
      rainLocked = updated.locked_reward_categories.includes("rain");
      if (!requiredLocks.every((category) =>
        updated.locked_reward_categories.includes(category)
      )) {
        throw new Error("Backend did not confirm all reward-abuse locks");
      }
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
        message: "Reward access or attributable balance could not be updated, so the review was left pending. Try again.",
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
