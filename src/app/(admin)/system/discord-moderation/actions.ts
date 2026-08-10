"use server";

import { revalidatePath } from "next/cache";

import { createAdminAuditEvent } from "@/lib/admin-audit";
import { requireAdmin, requirePageAccess } from "@/lib/dal";
import {
  getDiscordModerationSettings,
  saveDiscordModerationSettings,
  type DiscordModerationSettings,
} from "@/lib/discord-moderation-settings";
import {
  COMMUNITY_RANKS,
  COMMUNITY_XP_GUILD_ID,
  type CommunityLevelRole,
} from "@/lib/discord-community-ranks";
import {
  listCommunityLevelRoles,
  replaceCommunityLevelRoles,
} from "@/lib/discord-community-xp";

const Snowflake = /^\d{17,20}$/;

export async function updateDiscordCommunityRanksAction(
  roleIds: Record<string, string>,
): Promise<
  | { success: true; roles: CommunityLevelRole[] }
  | { success: false; error: string }
> {
  await requirePageAccess("/system/discord-moderation");
  const session = await requireAdmin();

  try {
    if (!roleIds || typeof roleIds !== "object" || Array.isArray(roleIds)) {
      return { success: false, error: "Invalid rank-role settings." };
    }
    const roles = COMMUNITY_RANKS.flatMap((rank) => {
      const roleId = typeof roleIds[String(rank.level)] === "string"
        ? roleIds[String(rank.level)]!.trim()
        : "";
      if (!roleId) return [];
      if (!Snowflake.test(roleId)) throw new Error(`${rank.name} needs a valid Discord role ID.`);
      return [{ level: rank.level, roleId }];
    });
    if (new Set(roles.map((role) => role.roleId)).size !== roles.length) {
      return { success: false, error: "Each rank must use a different Discord role." };
    }

    const previous = await listCommunityLevelRoles(COMMUNITY_XP_GUILD_ID);
    const saved = await replaceCommunityLevelRoles(COMMUNITY_XP_GUILD_ID, roles, session.userId);
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "discord_community_ranks_updated",
      metadata: {
        guildId: COMMUNITY_XP_GUILD_ID,
        previous,
        roles: saved,
        surface: "/system/discord-moderation",
      },
    });
    revalidatePath("/system/discord-moderation");
    return { success: true, roles: saved };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Could not save community ranks.",
    };
  }
}

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
