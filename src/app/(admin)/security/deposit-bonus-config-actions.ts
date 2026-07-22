"use server";

import { revalidateTag } from "next/cache";
import { SECURITY_CACHE_TAG } from "./security-cache-tag";
import { z } from "zod";
import { requirePageAccess, requireAdmin } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  getDepositBonusConfig,
  updateDepositBonusConfig,
  type UpdateDepositBonusConfigInput,
  type DepositBonusConfig,
} from "@/lib/backend-api/deposit-bonus-config";

/**
 * Update the affiliate deposit-bonus cap (`period_hours` — the rolling window
 * length — and/or `cap_per_period_usd` — the max bonus USD per window).
 *
 * Admin-only — this moves real bonus payouts, so the action sits behind
 * requireAdmin() (crypto-fees precedent) on top of the /security
 * page-access gate. We read the old value first so the audit event records
 * exactly what moved (old → new), then write through the backend API (which
 * validates + refreshes its own cache).
 */

// Mirror the backend: period_hours > 0 and ≤ 720; cap ≥ 0 and ≤ 100_000; at
// least one field present.
const InputSchema = z
  .object({
    period_hours: z.number().positive().max(720).optional(),
    cap_per_period_usd: z.number().min(0).max(100_000).optional(),
  })
  .refine(
    (data) =>
      data.period_hours !== undefined || data.cap_per_period_usd !== undefined,
    { message: "At least one value is required" },
  );

export async function updateDepositBonusConfigAction(
  input: UpdateDepositBonusConfigInput,
): Promise<
  | { success: true; data: DepositBonusConfig }
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

  let oldConfig: DepositBonusConfig | null = null;
  try {
    oldConfig = await getDepositBonusConfig();
  } catch {
    // Best-effort: if the backend is unreachable we still attempt the
    // write below (which will surface the real error). The audit "old"
    // side just records null in that case.
    oldConfig = null;
  }

  let updated: DepositBonusConfig;
  try {
    updated = await updateDepositBonusConfig(parsed.data);
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
    eventType: "deposit_bonus_config_updated",
    metadata: {
      changed: parsed.data,
      old: oldConfig,
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
