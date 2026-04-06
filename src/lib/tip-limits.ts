import { db } from "@/lib/db";

/**
 * Check if a creator can send a tip of the given amount.
 * tip_limit and creator_tip_tracking don't exist in prod DB yet,
 * so always allow for now.
 */
export async function checkTipLimit(
  _senderUserId: string,
  _amount: number
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  return { allowed: true };
}

/**
 * Record a tip for tracking purposes.
 * creator_tip_tracking table doesn't exist in prod DB yet, so this is a no-op.
 */
export async function recordTip(
  _senderUserId: string,
  _receiverUserId: string,
  _amount: number
): Promise<void> {
  // no-op: creator_tip_tracking table doesn't exist in prod
}
