"use server";

import { revalidateTag } from "next/cache";
import { SECURITY_CACHE_TAG } from "./security-cache-tag";
import { z } from "zod";
import { requirePageAccess, requireAdmin } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  getLeaderboardWagerWeights,
  updateLeaderboardWagerWeights,
  type UpdateLeaderboardWagerWeightsInput,
  type LeaderboardWagerWeights,
} from "@/lib/backend-api/leaderboard-wager-weights";

/**
 * Update the per-game leaderboard wager weights (official races + creator
 * leaderboards).
 *
 * Admin-only — these knobs shape race/leaderboard prize competition, so the
 * action sits behind requireAdmin() (wager-requirement-defaults precedent)
 * on top of the /security page-access gate. The card sends only the fields
 * the admin actually changed, already converted to bps ints. We read the
 * old weights first so the audit event records exactly what moved
 * (old → new), then write through the backend API (which validates +
 * refreshes its own cache).
 */

// Mirror the backend's WeightBps: int 0..1_000_000 (0 = game doesn't count).
const Bps = z.number().int().min(0).max(1_000_000);

const InputSchema = z
  .object({
    packs_bps: Bps.optional(),
    battles_bps: Bps.optional(),
    upgrader_bps: Bps.optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one value is required",
  });

export async function updateLeaderboardWagerWeightsAction(
  input: UpdateLeaderboardWagerWeightsInput,
): Promise<
  | { success: true; data: LeaderboardWagerWeights }
  | { success: false; error: string }
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

  let oldWeights: LeaderboardWagerWeights | null = null;
  try {
    oldWeights = await getLeaderboardWagerWeights();
  } catch {
    // Best-effort: if the backend is unreachable we still attempt the
    // write below (which will surface the real error). The audit "old"
    // side just records null in that case.
    oldWeights = null;
  }

  let updated: LeaderboardWagerWeights;
  try {
    updated = await updateLeaderboardWagerWeights(parsed.data);
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
    eventType: "leaderboard_wager_weights_updated",
    metadata: {
      changed: parsed.data,
      old: oldWeights,
      new: updated,
    },
  });

  // Narrow tag revalidation only — the client card updates optimistically in
  // place (no router.refresh), so a broad revalidatePath("/security") would
  // just re-render the whole route and jump scroll. The tag busts the cached
  // /security reads so a genuine future load shows fresh data.
  revalidateTag(SECURITY_CACHE_TAG);
  return { success: true, data: updated };
}
