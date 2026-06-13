"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePageAccess, requireAdmin } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  getShardConfig,
  updateShardConfig,
  type UpdateShardConfigInput,
  type ShardConfig,
} from "@/lib/backend-api/shard-config";

/**
 * Update the shard earn rate (`usd_per_shard` — how much weighted wager a
 * user needs to accumulate to earn one shard).
 *
 * Admin-only — this is the headline knob of the shard economy, so the action
 * sits behind requireAdmin() (shard-/leaderboard-weights precedent) on top of
 * the /security page-access gate. We read the old value first so the audit
 * event records exactly what moved (old → new), then write through the
 * backend API (which validates + refreshes its own cache).
 */

// Mirror the backend's UsdPerShard: positive, max 100_000.
const InputSchema = z.object({
  usd_per_shard: z.number().positive().max(100_000),
});

export async function updateShardConfigAction(
  input: UpdateShardConfigInput,
): Promise<
  { success: true; data: ShardConfig } | { success: false; error: string }
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

  let oldConfig: ShardConfig | null = null;
  try {
    oldConfig = await getShardConfig();
  } catch {
    // Best-effort: if the backend is unreachable we still attempt the
    // write below (which will surface the real error). The audit "old"
    // side just records null in that case.
    oldConfig = null;
  }

  let updated: ShardConfig;
  try {
    updated = await updateShardConfig(parsed.data);
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
    eventType: "shard_config_updated",
    metadata: {
      changed: parsed.data,
      old: oldConfig,
      new: updated,
    },
  });

  revalidatePath("/security");
  return { success: true, data: updated };
}
