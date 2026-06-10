"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePageAccess, requireAdmin } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  getRewardExpiry,
  updateRewardExpiry,
  type UpdateRewardExpiryInput,
  type RewardExpiry,
} from "@/lib/backend-api/reward-expiry";

/**
 * Update the reward claim windows (rakeback per-type + race + leaderboard +
 * balance rewards).
 *
 * Admin-only — these knobs decide when users lose unclaimed prizes, so the
 * action sits behind requireAdmin() (wager-weights precedent) on top of the
 * /security page-access gate. The card sends only the fields the admin
 * actually changed, already converted to day ints. We read the old config
 * first so the audit event records exactly what moved (old → new), then
 * write through the backend API (which validates + refreshes its own
 * cache).
 */

// Mirror the backend's ExpiryDays: int 0..3650 (0 = never expires).
const Days = z.number().int().min(0).max(3650);

const InputSchema = z
  .object({
    rakeback: z
      .object({
        daily_days: Days.optional(),
        weekly_days: Days.optional(),
        monthly_days: Days.optional(),
      })
      .optional(),
    race_days: Days.optional(),
    leaderboard_days: Days.optional(),
    balance_days: Days.optional(),
  })
  .refine(
    (data) =>
      data.race_days !== undefined ||
      data.leaderboard_days !== undefined ||
      data.balance_days !== undefined ||
      (data.rakeback &&
        Object.values(data.rakeback).some((v) => v !== undefined)),
    { message: "At least one value is required" },
  );

export async function updateRewardExpiryAction(
  input: UpdateRewardExpiryInput,
): Promise<
  { success: true; data: RewardExpiry } | { success: false; error: string }
> {
  await requirePageAccess("/security");
  const session = await requireAdmin();

  const parsed = InputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  let oldExpiry: RewardExpiry | null = null;
  try {
    oldExpiry = await getRewardExpiry();
  } catch {
    // Best-effort: if the backend is unreachable we still attempt the
    // write below (which will surface the real error). The audit "old"
    // side just records null in that case.
    oldExpiry = null;
  }

  let updated: RewardExpiry;
  try {
    updated = await updateRewardExpiry(parsed.data);
  } catch (err) {
    return {
      success: false,
      error:
        err instanceof Error
          ? err.message
          : "Backend not updated yet — feature awaiting backend deploy",
    };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "reward_expiry_updated",
    metadata: {
      changed: parsed.data,
      old: oldExpiry,
      new: updated,
    },
  });

  revalidatePath("/security");
  return { success: true, data: updated };
}
