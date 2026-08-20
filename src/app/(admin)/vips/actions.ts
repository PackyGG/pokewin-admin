"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAdmin, requirePageAccess } from "@/lib/dal";
import {
  resetVipPerksQualification,
  updateVipPerksSettings,
} from "@/lib/vip-perks";

import type { VipPerksSettingsView } from "./vip-perks-settings-card";

const SettingsSchema = z
  .object({
    enabled: z.boolean(),
    initialWagerWithoutCreatorCodeUsd: z.number().positive().max(100_000_000),
    initialWagerWithCreatorCodeUsd: z.number().positive().max(100_000_000),
    recurringEnabled: z.boolean(),
    recurringWagerUsd: z.number().positive().max(100_000_000).nullable(),
  })
  .refine(
    (value) => !value.recurringEnabled || value.recurringWagerUsd !== null,
    {
      message: "Recurring wager is required when recurring access is enabled",
      path: ["recurringWagerUsd"],
    },
  );

const UserIdSchema = z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/);

type ActionResult<T = undefined> =
  | (T extends undefined ? { success: true } : { success: true; data: T })
  | { success: false; error: string };

export async function updateVipPerksSettingsAction(
  input: Omit<VipPerksSettingsView, "initialWagerCountingStartedAt">,
): Promise<ActionResult<VipPerksSettingsView>> {
  await requirePageAccess("/vips");
  const session = await requireAdmin();
  const parsed = SettingsSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid VIP perk settings",
    };
  }

  try {
    const updated = await updateVipPerksSettings({
      ...parsed.data,
      actorAdminId: session.userId,
    });
    const view: VipPerksSettingsView = {
      enabled: updated.enabled,
      initialWagerWithoutCreatorCodeUsd: updated.initialWagerWithoutCreatorCodeUsd,
      initialWagerWithCreatorCodeUsd: updated.initialWagerWithCreatorCodeUsd,
      initialWagerCountingStartedAt: updated.initialWagerCountingStartedAt,
      recurringEnabled: updated.recurringEnabled,
      recurringWagerUsd: updated.recurringWagerUsd,
    };
    revalidatePath("/vips");
    return { success: true, data: view };
  } catch (error) {
    console.error("[vips] failed to update perk settings:", error);
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to update VIP perk settings",
    };
  }
}

export async function resetVipPerksQualificationAction(
  userId: string,
): Promise<ActionResult> {
  await requirePageAccess("/vips");
  const session = await requireAdmin();
  const parsed = UserIdSchema.safeParse(userId);
  if (!parsed.success) {
    return { success: false, error: "Invalid Packy user ID" };
  }

  try {
    await resetVipPerksQualification({
      userId: parsed.data,
      actorAdminId: session.userId,
      idempotencyKey: crypto.randomUUID(),
    });
    revalidatePath("/vips");
    return { success: true };
  } catch (error) {
    console.error("[vips] failed to reset qualification:", error);
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to reset VIP qualification window",
    };
  }
}
