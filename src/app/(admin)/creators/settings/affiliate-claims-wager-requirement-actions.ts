"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePageAccess, requireAdmin } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  getWagerRequirementDefaults,
  updateWagerRequirementDefaults,
  type WagerRequirementDefaults,
} from "@/lib/backend-api/wager-requirements";

const Bps = z.number().int().min(0).max(1_000_000);

const InputSchema = z.object({
  affiliate_wager_requirement_bps: Bps,
});

/**
 * Update the affiliate-claims withdrawal wager requirement (moved from
 * /security to /creators/settings — affiliate policy belongs with creator
 * config). Writes through the same backend defaults endpoint.
 */
export async function updateAffiliateClaimsWagerRequirementAction(
  affiliate_wager_requirement_bps: number,
): Promise<
  | { success: true; data: WagerRequirementDefaults }
  | { success: false; error: string }
> {
  await requirePageAccess("/creators/settings");
  const session = await requireAdmin();

  const parsed = InputSchema.safeParse({ affiliate_wager_requirement_bps });
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
      surface: "/creators/settings",
    },
  });

  revalidatePath("/creators/settings");
  revalidatePath("/security");
  return { success: true, data: updated };
}
