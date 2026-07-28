"use server";

import { revalidateTag } from "next/cache";
import { z } from "zod";

import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  getKenoConfig,
  updateKenoConfig,
  type KenoConfig,
  type UpdateKenoConfigInput,
} from "@/lib/backend-api/keno-config";
import {
  requirePageAccess,
  sessionIsAdmin,
  sessionIsOwner,
} from "@/lib/dal";
import {
  KENO_MAX_CONFIGURABLE_BET_USD,
  KENO_MIN_BET_USD,
} from "@/lib/keno/payouts";
import { KENO_CONFIG_CACHE_TAG } from "./_cached-reads";

const InputSchema = z.object({
  max_bet_usd: z
    .number()
    .finite()
    .min(KENO_MIN_BET_USD)
    .max(KENO_MAX_CONFIGURABLE_BET_USD),
});

export async function updateKenoConfigAction(
  input: UpdateKenoConfigInput,
): Promise<
  | { success: true; data: KenoConfig }
  | { success: false; error: string }
> {
  const session = await requirePageAccess("/keno");
  if (!sessionIsAdmin(session) && !sessionIsOwner(session)) {
    return { success: false, error: "Admin access is required" };
  }

  const parsed = InputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid Keno configuration",
    };
  }

  let oldConfig: KenoConfig | null = null;
  try {
    oldConfig = await getKenoConfig();
  } catch {
    oldConfig = null;
  }

  let updated: KenoConfig;
  try {
    updated = await updateKenoConfig(parsed.data);
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "The Keno configuration could not be updated",
    };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "keno_config_updated",
    metadata: {
      changed: parsed.data,
      old: oldConfig,
      new: updated,
    },
  });

  revalidateTag(KENO_CONFIG_CACHE_TAG);
  return { success: true, data: updated };
}
