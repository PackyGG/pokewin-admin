"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePageAccess, requireAdmin } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  getWagerRequirementDefaults,
  updateWagerRequirementDefaults,
  type UpdateWagerRequirementDefaultsInput,
  type WagerRequirementDefaults,
} from "@/lib/backend-api/wager-requirements";

/**
 * Update the site-wide withdrawal wager-requirement defaults.
 *
 * Admin-only — these knobs gate every withdrawal on the platform, so the
 * action sits behind requireAdmin() (battle-limits precedent) on top of
 * the /security page-access gate. The card sends only the fields the admin
 * actually changed, already converted to bps ints. We read the old
 * defaults first so the audit event records exactly what moved (old → new),
 * then write through the backend API (which validates + refreshes its own
 * cache — no separate refreshSiteConfig ping needed, unlike rain).
 */

// Mirror the backend's WagerRequirementBps: int 0..1_000_000 (0 = disabled).
const Bps = z.number().int().min(0).max(1_000_000);

const InputSchema = z
  .object({
    wager_requirement_bps: Bps.optional(),
    bonus_wager_requirement_bps: Bps.optional(),
    rakeback_wager_requirement_bps: Bps.optional(),
    tips_wager_requirement_bps: Bps.optional(),
    wager_weight_packs_bps: Bps.optional(),
    wager_weight_battles_bps: Bps.optional(),
    wager_weight_upgrader_bps: Bps.optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one value is required",
  });

export async function updateWagerRequirementDefaultsAction(
  input: UpdateWagerRequirementDefaultsInput,
): Promise<
  | { success: true; data: WagerRequirementDefaults }
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

  let oldDefaults: WagerRequirementDefaults | null = null;
  try {
    oldDefaults = await getWagerRequirementDefaults();
  } catch {
    // Best-effort: if the backend is unreachable we still attempt the
    // write below (which will surface the real error). The audit "old"
    // side just records null in that case.
    oldDefaults = null;
  }

  let updated: WagerRequirementDefaults;
  try {
    updated = await updateWagerRequirementDefaults(parsed.data);
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
    eventType: "wager_requirement_defaults_updated",
    metadata: {
      changed: parsed.data,
      old: oldDefaults,
      new: updated,
    },
  });

  revalidatePath("/security");
  revalidatePath("/creators/settings");
  return { success: true, data: updated };
}
