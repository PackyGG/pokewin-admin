"use server";

import { revalidateTag } from "next/cache";
import { SECURITY_CACHE_TAG } from "./security-cache-tag";
import { z } from "zod";
import { requirePageAccess, requireAdmin } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  getTelegramNotificationSettings,
  updateTelegramNotificationSettings,
  type UpdateTelegramNotificationSettingsInput,
  type TelegramNotificationSettings,
} from "@/lib/backend-api/telegram-notifications";

/**
 * Update the Telegram admin-notification settings (minimum deposit USD that
 * triggers a deposit alert, and/or whether new signups post an alert).
 *
 * Admin-only — these control what lands in the ops chat, so the action sits
 * behind requireAdmin() (deposit-bonus-config precedent) on top of the
 * /security page-access gate. We read the old value first so the audit event
 * records exactly what moved (old → new), then write through the backend API
 * (which validates + refreshes its own cache).
 */

// Mirror the backend: depositMinUsd >= 0; at least one field present. The
// upper bound is a local sanity cap — a threshold above this would silence
// effectively every deposit, which is almost certainly a typo.
const MAX_DEPOSIT_MIN_USD = 100_000;

const InputSchema = z
  .object({
    masterEnabled: z.boolean().optional(),
    depositMinUsd: z.number().min(0).max(MAX_DEPOSIT_MIN_USD).optional(),
    depositConfirmed: z.boolean().optional(),
    depositFailed: z.boolean().optional(),
    withdrawalRequested: z.boolean().optional(),
    withdrawalCompleted: z.boolean().optional(),
    withdrawalFailed: z.boolean().optional(),
    signupNotificationsEnabled: z.boolean().optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one value is required",
  });

export async function updateTelegramNotificationsAction(
  input: UpdateTelegramNotificationSettingsInput,
): Promise<
  | { success: true; data: TelegramNotificationSettings }
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

  let oldSettings: TelegramNotificationSettings | null = null;
  try {
    oldSettings = await getTelegramNotificationSettings();
  } catch {
    // Best-effort: if the backend is unreachable we still attempt the
    // write below (which will surface the real error). The audit "old"
    // side just records null in that case.
    oldSettings = null;
  }

  let updated: TelegramNotificationSettings;
  try {
    updated = await updateTelegramNotificationSettings(parsed.data);
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
    eventType: "telegram_notifications_updated",
    metadata: {
      changed: parsed.data,
      old: oldSettings,
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
