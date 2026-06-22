"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePageAccess, requireAdmin } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { BackendApiError } from "@/lib/backend-api/errors";
import {
  getUserWagerRequirement,
  setUserWagerRequirement,
  clearUserWagerRequirement,
  setUserWagerRemainingDebt,
} from "@/lib/backend-api/wager-requirements";

/**
 * Per-user withdrawal wager-requirement overrides.
 *
 * Admin-only — overrides directly gate a user's ability to withdraw real
 * money, so both actions sit behind requireAdmin() (battle-limits
 * precedent) on top of the /users page-access gate. They go through the
 * backend API (which owns validation + the override table); the panel
 * never writes the MAIN DB. We read the current value first so the audit
 * event records old → new.
 *
 * Kept in their own module (not the giant users/[id]/actions.ts) so the
 * server-only backend-api import stays scoped to this feature.
 */

const SourceBps = z.number().int().min(0).max(1_000_000).nullable().optional();

const SetSchema = z.object({
  userId: z.string().min(1),
  // 0 = user fully EXEMPT for deposit source (the entire requirement, bonus part included).
  wager_requirement_bps: z.number().int().min(0).max(1_000_000).optional(),
  bonus_wager_requirement_bps: SourceBps,
  affiliate_wager_requirement_bps: SourceBps,
  affiliate_leaderboard_wager_requirement_bps: SourceBps,
  rakeback_wager_requirement_bps: SourceBps,
  tips_wager_requirement_bps: SourceBps,
  admin_adjustment_wager_requirement_bps: SourceBps,
});

function friendlyError(err: unknown): string {
  if (err instanceof BackendApiError) {
    if (err.isNotFound) return "User not found in backend";
    return err.message;
  }
  // BackendNetworkError or anything else — the branch likely isn't deployed.
  return "Backend not updated yet — feature awaiting backend deploy";
}

export async function setUserWagerRequirementAction(input: {
  userId: string;
  wager_requirement_bps?: number;
  bonus_wager_requirement_bps?: number | null;
  affiliate_wager_requirement_bps?: number | null;
  affiliate_leaderboard_wager_requirement_bps?: number | null;
  rakeback_wager_requirement_bps?: number | null;
  tips_wager_requirement_bps?: number | null;
  admin_adjustment_wager_requirement_bps?: number | null;
}): Promise<{ success: true } | { success: false; error: string }> {
  await requirePageAccess("/users");
  const session = await requireAdmin();

  const parsed = SetSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const { userId, ...fields } = parsed.data;

  // Read current for the audit old side (best-effort).
  let oldValues: Record<string, number | null | undefined> = {};
  try {
    const current = await getUserWagerRequirement(userId);
    oldValues = {
      wager_requirement_bps: current.wager_requirement_bps,
      bonus_wager_requirement_bps: current.bonus_wager_requirement_bps,
      affiliate_wager_requirement_bps: current.affiliate_wager_requirement_bps,
      affiliate_leaderboard_wager_requirement_bps: current.affiliate_leaderboard_wager_requirement_bps,
      rakeback_wager_requirement_bps: current.rakeback_wager_requirement_bps,
      tips_wager_requirement_bps: current.tips_wager_requirement_bps,
      admin_adjustment_wager_requirement_bps: current.admin_adjustment_wager_requirement_bps,
    };
  } catch {
    oldValues = {};
  }

  try {
    await setUserWagerRequirement(userId, fields);
  } catch (err) {
    return { success: false, error: friendlyError(err) };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "user_wager_requirement_updated",
    targetUserId: userId,
    metadata: { old: oldValues, new: fields },
  });

  revalidatePath(`/users/${userId}`);
  return { success: true };
}

export async function clearUserWagerRequirementAction(
  userId: string,
): Promise<{ success: true } | { success: false; error: string }> {
  await requirePageAccess("/users");
  const session = await requireAdmin();

  if (!userId || typeof userId !== "string") {
    return { success: false, error: "Invalid user id" };
  }

  let oldBps: number | null | undefined;
  try {
    const current = await getUserWagerRequirement(userId);
    oldBps = current.wager_requirement_bps;
  } catch {
    oldBps = undefined;
  }

  try {
    await clearUserWagerRequirement(userId);
  } catch (err) {
    return { success: false, error: friendlyError(err) };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "user_wager_requirement_cleared",
    targetUserId: userId,
    metadata: { old_bps: oldBps ?? null },
  });

  revalidatePath(`/users/${userId}`);
  return { success: true };
}

const SetRemainingDebtSchema = z.object({
  userId: z.string().min(1),
  amountUsd: z
    .string()
    .regex(/^[0-9]+(\.[0-9]+)?$/, "Must be a non-negative decimal number")
    .refine((v) => parseFloat(v) >= 0, {
      message: "Amount must be >= 0",
    }),
});

/**
 * Directly set the user's wager_requirement_remaining (the frozen debt
 * counter). amountUsd = "0" clears the debt so the user can withdraw
 * immediately.
 */
export async function setUserWagerRemainingAction(input: {
  userId: string;
  amountUsd: string;
}): Promise<{ success: true } | { success: false; error: string }> {
  await requirePageAccess("/users");
  const session = await requireAdmin();

  const parsed = SetRemainingDebtSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const { userId, amountUsd } = parsed.data;

  let result: { old_remaining_usd: string; new_remaining_usd: string };
  try {
    result = await setUserWagerRemainingDebt(userId, amountUsd);
  } catch (err) {
    return { success: false, error: friendlyError(err) };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "user_wager_remaining_adjusted",
    targetUserId: userId,
    metadata: {
      amount_usd: amountUsd,
      old_remaining_usd: result.old_remaining_usd,
      new_remaining_usd: result.new_remaining_usd,
    },
  });

  revalidatePath(`/users/${userId}`);
  return { success: true };
}
