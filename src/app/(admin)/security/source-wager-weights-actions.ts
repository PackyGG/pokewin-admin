"use server";

import { revalidateTag } from "next/cache";
import { SECURITY_CACHE_TAG } from "./security-cache-tag";
import { z } from "zod";
import { requirePageAccess, requireAdmin } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  getSourceWagerWeights,
  updateSourceWagerWeights,
  type UpdateSourceWagerWeightsInput,
  type SourceWagerWeights,
} from "@/lib/backend-api/source-wager-weights";

/**
 * Update the per-funding-source wager weights (withdrawal + rakeback +
 * leaderboard).
 *
 * Admin-only — these knobs shape how much bonus-funded wager counts toward
 * the withdrawal gate, rakeback and race leaderboards, so the
 * action sits behind requireAdmin()
 * (rakeback / leaderboard-weights precedent) on top of the /security
 * page-access gate. The card sends only the fields the admin actually
 * changed, already converted to bps ints. We read the old weights first so
 * the audit event records exactly what moved (old → new), then write through
 * the backend API (which validates + refreshes its own cache).
 */

// Mirror the backend's WeightBps: int 0..1_000_000 (0 = source doesn't count).
const Bps = z.number().int().min(0).max(1_000_000);

const PartialSourceWeights = z
  .object({
    race_prize: Bps.optional(),
    bonus_other: Bps.optional(),
    rakeback: Bps.optional(),
    affiliate: Bps.optional(),
    tips: Bps.optional(),
  })
  .optional();

const InputSchema = z
  .object({
    withdrawal: PartialSourceWeights,
    rakeback: PartialSourceWeights,
    leaderboard: PartialSourceWeights,
  })
  .refine(
    (data) =>
      [data.withdrawal, data.rakeback, data.leaderboard].some(
        (group) =>
          group && Object.values(group).some((v) => v !== undefined),
      ),
    { message: "At least one value is required" },
  );

export async function updateSourceWagerWeightsAction(
  input: UpdateSourceWagerWeightsInput,
): Promise<
  | { success: true; data: SourceWagerWeights }
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

  let oldWeights: SourceWagerWeights | null = null;
  try {
    oldWeights = await getSourceWagerWeights();
  } catch {
    // Best-effort: if the backend is unreachable we still attempt the write
    // below (which will surface the real error). The audit "old" side just
    // records null in that case.
    oldWeights = null;
  }

  let updated: SourceWagerWeights;
  try {
    updated = await updateSourceWagerWeights(parsed.data);
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
    eventType: "source_wager_weights_updated",
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
