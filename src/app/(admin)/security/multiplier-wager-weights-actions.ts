"use server";

import { revalidateTag } from "next/cache";
import { SECURITY_CACHE_TAG } from "./security-cache-tag";
import { z } from "zod";
import { requirePageAccess, requireAdmin } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  getMultiplierWagerWeights,
  updateMultiplierWagerWeights,
  MAX_MULTIPLIER_TIERS,
  type UpdateMultiplierWagerWeightsInput,
  type MultiplierWagerWeights,
} from "@/lib/backend-api/multiplier-wager-weights";

/**
 * Update the odds-based (bet-multiplier) wager weights — per destination
 * (withdrawal / rakeback / leaderboard) an enable toggle plus an
 * ordered discount-tier list for low-multiplier upgrader bets.
 *
 * Admin-only — these knobs shape how much low-multiplier wager counts
 * toward the withdrawal gate, rakeback and race leaderboards, so the
 * action sits behind requireAdmin() (same precedent as the
 * other wager-weight cards) on top of the /security page-access gate. The
 * card sends only the destinations the admin actually changed; a changed
 * tier list arrives as the FULL replacement list (the backend replaces
 * stored tiers wholesale), already converted from percent to bps ints. We
 * read the old config first so the audit event records exactly what moved
 * (old → new), then write through the backend API (which re-validates and
 * 400s on violations).
 */

// Mirror the backend's validation exactly: weight_bps int 0..10000,
// max_x finite > 1 and <= 100000, 0–10 tiers, strictly ascending max_x.
const WeightBps = z
  .number()
  .int()
  .min(0)
  .max(10000, { message: "Tier weight must be between 0 and 10000 bps" });

const MaxX = z
  .number()
  .finite()
  .gt(1, { message: "Tier bound must be greater than 1×" })
  .max(100000, { message: "Tier bound must be at most 100000×" });

const Tier = z.object({ max_x: MaxX, weight_bps: WeightBps });

const Tiers = z
  .array(Tier)
  .max(MAX_MULTIPLIER_TIERS, {
    message: `At most ${MAX_MULTIPLIER_TIERS} tiers per destination`,
  })
  .refine(
    (tiers) => tiers.every((t, i) => i === 0 || tiers[i - 1].max_x < t.max_x),
    { message: "Tier bounds must be strictly ascending" },
  );

const DestinationPatch = z
  .object({
    enabled: z.boolean().optional(),
    tiers: Tiers.optional(),
  })
  .optional();

const InputSchema = z
  .object({
    withdrawal: DestinationPatch,
    rakeback: DestinationPatch,
    leaderboard: DestinationPatch,
  })
  .refine(
    (data) =>
      [data.withdrawal, data.rakeback, data.leaderboard].some(
        (group) =>
          group && (group.enabled !== undefined || group.tiers !== undefined),
      ),
    { message: "At least one value is required" },
  );

export async function updateMultiplierWagerWeightsAction(
  input: UpdateMultiplierWagerWeightsInput,
): Promise<
  | { success: true; data: MultiplierWagerWeights }
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

  let oldWeights: MultiplierWagerWeights | null = null;
  try {
    oldWeights = await getMultiplierWagerWeights();
  } catch {
    // Best-effort: if the backend is unreachable we still attempt the write
    // below (which will surface the real error). The audit "old" side just
    // records null in that case.
    oldWeights = null;
  }

  let updated: MultiplierWagerWeights;
  try {
    updated = await updateMultiplierWagerWeights(parsed.data);
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
    eventType: "multiplier_wager_weights_updated",
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
