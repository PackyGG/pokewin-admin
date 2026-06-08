"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePageAccess, requireAdmin } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  getRakebackWagerWeights,
  updateRakebackWagerWeights,
  type UpdateRakebackWagerWeightsInput,
  type RakebackWagerWeights,
} from "@/lib/backend-api/rakeback-wager-weights";

/**
 * Update the per-game rakeback wager weights.
 *
 * Admin-only — these knobs shape how much rakeback each game pays out, so
 * the action sits behind requireAdmin() (wager-requirement-defaults /
 * leaderboard-weights precedent) on top of the /security page-access gate.
 * The card sends only the fields the admin actually changed, already
 * converted to bps ints. We read the old weights first so the audit event
 * records exactly what moved (old → new), then write through the backend
 * API (which validates + refreshes its own cache).
 */

// Mirror the backend's WeightBps: int 0..1_000_000 (0 = game earns no rakeback).
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

export async function updateRakebackWagerWeightsAction(
  input: UpdateRakebackWagerWeightsInput,
): Promise<
  | { success: true; data: RakebackWagerWeights }
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

  let oldWeights: RakebackWagerWeights | null = null;
  try {
    oldWeights = await getRakebackWagerWeights();
  } catch {
    // Best-effort: if the backend is unreachable we still attempt the
    // write below (which will surface the real error). The audit "old"
    // side just records null in that case.
    oldWeights = null;
  }

  let updated: RakebackWagerWeights;
  try {
    updated = await updateRakebackWagerWeights(parsed.data);
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
    eventType: "rakeback_wager_weights_updated",
    metadata: {
      changed: parsed.data,
      old: oldWeights,
      new: updated,
    },
  });

  revalidatePath("/security");
  return { success: true, data: updated };
}
