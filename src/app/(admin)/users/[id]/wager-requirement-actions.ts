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

const Bps = z.number().int().min(0).max(1_000_000);

const SetSchema = z.object({
  userId: z.string().min(1),
  // 0 = user fully EXEMPT (the entire requirement, bonus part included).
  bps: Bps,
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
  bps: number;
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
  const { userId, bps } = parsed.data;

  // Read current for the audit old side (best-effort).
  let oldBps: number | null | undefined;
  try {
    const current = await getUserWagerRequirement(userId);
    oldBps = current.wager_requirement_bps;
  } catch {
    oldBps = undefined;
  }

  try {
    await setUserWagerRequirement(userId, bps);
  } catch (err) {
    return { success: false, error: friendlyError(err) };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "user_wager_requirement_updated",
    targetUserId: userId,
    metadata: { old_bps: oldBps ?? null, new_bps: bps },
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
