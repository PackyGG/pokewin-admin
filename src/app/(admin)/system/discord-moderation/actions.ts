"use server";

import { revalidatePath } from "next/cache";

import { createAdminAuditEvent } from "@/lib/admin-audit";
import { requireAdmin, requirePageAccess } from "@/lib/dal";
import {
  getDiscordModerationSettings,
  saveDiscordModerationSettings,
  type DiscordModerationSettings,
} from "@/lib/discord-moderation-settings";

export async function updateDiscordModerationSettingsAction(
  input: DiscordModerationSettings,
): Promise<
  | { success: true; settings: DiscordModerationSettings }
  | { success: false; error: string }
> {
  await requirePageAccess("/system/discord-moderation");
  const session = await requireAdmin();

  try {
    const previous = await getDiscordModerationSettings();
    const settings = await saveDiscordModerationSettings(input, session.userId);
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "discord_moderation_settings_updated",
      metadata: {
        guildId: settings.guildId,
        previous,
        settings,
        surface: "/system/discord-moderation",
      },
    });
    revalidatePath("/system/discord-moderation");
    return { success: true, settings };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Could not save moderation settings.",
    };
  }
}
