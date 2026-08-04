import "server-only";

import { and, eq, inArray, isNotNull } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { discord_creator_setups } from "@/lib/db-schema/admin/schema";

/**
 * Creator ↔ Discord link state, sourced from the Discord creator-setup bot.
 *
 * The bot writes `discord_creator_setups` (admin DB): a row starts `pending`
 * when the setup is prepared, flips to `active` once the category + channels
 * exist, and gets `creator_user_id` filled in when the Discord account is
 * linked to a packy user (`/link`). A row with `status = 'active'` AND a
 * non-null `creator_user_id` is the ONLY definition of "this creator's
 * Discord is linked" — that pairing is enforced by the table's
 * `discord_creator_setups_link_shape_check` constraint.
 *
 * This replaces the old manual `creator_socials` discord handle +
 * `discord_channel_url` column, which were typed in by hand at creator-add
 * time and drifted from reality.
 *
 * Read-only against the ADMIN DB (never MAIN).
 */

export type CreatorDiscordLink = {
  /** Discord user id of the creator (snowflake). */
  discordUserId: string;
  guildId: string;
  /** Creator's private category name in the Discord server, when known. */
  categoryName: string | null;
  /** Deep link to the creator's chat channel, when the channel is known. */
  channelUrl: string | null;
  /** ISO timestamp of when the Discord account was linked. */
  linkedAt: string | null;
};

function toLink(row: {
  creator_discord_user_id: string;
  guild_id: string;
  category_name: string | null;
  chat_channel_id: string | null;
  linked_at: string | null;
}): CreatorDiscordLink {
  return {
    discordUserId: row.creator_discord_user_id,
    guildId: row.guild_id,
    categoryName: row.category_name,
    channelUrl: row.chat_channel_id
      ? `https://discord.com/channels/${row.guild_id}/${row.chat_channel_id}`
      : null,
    linkedAt: row.linked_at,
  };
}

/**
 * Batched roster read: userId → Discord link. Users without a linked,
 * active setup are simply absent from the map.
 */
export async function getDiscordLinksByUser(
  userIds: string[],
): Promise<Map<string, CreatorDiscordLink>> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return new Map();

  const rows = await adminDrizzle
    .select({
      creator_user_id: discord_creator_setups.creator_user_id,
      creator_discord_user_id: discord_creator_setups.creator_discord_user_id,
      guild_id: discord_creator_setups.guild_id,
      category_name: discord_creator_setups.category_name,
      chat_channel_id: discord_creator_setups.chat_channel_id,
      linked_at: discord_creator_setups.linked_at,
    })
    .from(discord_creator_setups)
    .where(
      and(
        eq(discord_creator_setups.status, "active"),
        isNotNull(discord_creator_setups.creator_user_id),
        inArray(discord_creator_setups.creator_user_id, ids),
      ),
    );

  const map = new Map<string, CreatorDiscordLink>();
  for (const row of rows) {
    if (!row.creator_user_id) continue;
    map.set(row.creator_user_id, toLink(row));
  }
  return map;
}

/** Single-creator read for the creator detail page. */
export async function getDiscordLinkForUser(
  userId: string,
): Promise<CreatorDiscordLink | null> {
  const map = await getDiscordLinksByUser([userId]);
  return map.get(userId) ?? null;
}
