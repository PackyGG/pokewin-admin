import { db } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";

/**
 * Check if a creator can send a tip of the given amount.
 * Returns { allowed: true } or { allowed: false, reason: string }.
 */
export async function checkTipLimit(
  senderUserId: string,
  amount: number
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  const limits = await db.creator_withdrawal_limits.findUnique({
    where: { user_id: senderUserId },
  });

  // No limits configured = no restriction
  if (!limits || limits.tip_limit === null) {
    return { allowed: true };
  }

  const tipLimit = toNumber(limits.tip_limit);
  if (tipLimit <= 0) {
    return { allowed: false, reason: "Tipping is disabled for your account" };
  }

  const resetDays = limits.tip_limit_reset_days ?? 7; // default weekly
  const periodStart = new Date();
  periodStart.setDate(periodStart.getDate() - resetDays);

  // Sum tips in current period
  const result = await db.$queryRawUnsafe<{ total: string }[]>(
    `SELECT COALESCE(SUM(amount::numeric), 0)::text AS total
     FROM creator_tip_tracking
     WHERE sender_user_id = $1 AND created_at >= $2`,
    senderUserId,
    periodStart
  );

  const tippedSoFar = Number(result[0]?.total ?? 0);
  const remaining = tipLimit - tippedSoFar;

  if (amount > remaining) {
    return {
      allowed: false,
      reason: `Tip limit exceeded. You have ${remaining.toFixed(2)} remaining of your ${tipLimit.toFixed(2)} limit (resets every ${resetDays} days)`,
    };
  }

  return { allowed: true };
}

/**
 * Record a tip for tracking purposes. Call this after successfully processing the tip.
 */
export async function recordTip(
  senderUserId: string,
  receiverUserId: string,
  amount: number
): Promise<void> {
  const periodStart = new Date();
  periodStart.setDate(periodStart.getDate() - (periodStart.getDay() || 7)); // start of week
  periodStart.setHours(0, 0, 0, 0);

  await db.creator_tip_tracking.create({
    data: {
      sender_user_id: senderUserId,
      receiver_user_id: receiverUserId,
      amount,
      period_start: periodStart,
    },
  });
}
