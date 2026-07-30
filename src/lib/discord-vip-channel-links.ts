import "server-only";

import { eq, sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { admin_audit_events } from "@/lib/db-schema/admin/schema";
import { user } from "@/lib/db-schema/main/schema";
import { getProdReadDrizzleDb } from "@/lib/db";

export const VIPS_GUILD_ID = "1505650386894327919";

export type VipLinkUserPreview = {
  userId: string;
  username: string | null;
  displayUsername: string | null;
};

export type VipChannelLink = VipLinkUserPreview & {
  guildId: string;
  channelId: string;
};

export class VipChannelLinkError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "VipChannelLinkError";
  }
}

type LinkRow = {
  guild_id: string;
  user_id: string;
  channel_id: string;
  linked_by_discord_user_id: string;
};

type OperationRow = {
  interaction_id: string;
  guild_id: string;
  user_id: string;
  channel_id: string;
  actor_discord_user_id: string;
  status: "linked" | "updated" | "already_linked";
};

async function requireUser(userId: string): Promise<VipLinkUserPreview> {
  const db = getProdReadDrizzleDb();
  const [found] = await db
    .select({
      userId: user.id,
      username: user.username,
      displayUsername: user.display_username,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  if (!found) {
    throw new VipChannelLinkError(
      404,
      "user_not_found",
      "That Packy user ID does not exist.",
    );
  }
  return found;
}

export async function previewVipChannelLink(
  userId: string,
): Promise<VipLinkUserPreview> {
  return requireUser(userId);
}

export async function saveVipChannelLink(input: {
  guildId: string;
  channelId: string;
  userId: string;
  actorDiscordUserId: string;
  interactionId: string;
  apiKeyId: string;
  apiKeyPrefix: string;
}): Promise<{
  status: "linked" | "updated" | "already_linked";
  link: VipChannelLink;
}> {
  const preview = await requireUser(input.userId);

  return adminDrizzle.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`discord-vip-link-user:${input.guildId}:${input.userId}`}, 0)
      )
    `);
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`discord-vip-link-channel:${input.guildId}:${input.channelId}`}, 0)
      )
    `);
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`discord-vip-link-interaction:${input.interactionId}`}, 0)
      )
    `);

    const operationResult = await tx.execute<OperationRow>(sql`
      SELECT
        interaction_id,
        guild_id,
        user_id,
        channel_id,
        actor_discord_user_id,
        status
      FROM discord_vip_channel_link_operations
      WHERE interaction_id = ${input.interactionId}
      FOR UPDATE
    `);
    const operation = operationResult.rows[0];
    if (operation) {
      if (
        operation.guild_id !== input.guildId ||
        operation.user_id !== input.userId ||
        operation.channel_id !== input.channelId ||
        operation.actor_discord_user_id !== input.actorDiscordUserId
      ) {
        throw new VipChannelLinkError(
          409,
          "idempotency_conflict",
          "That Discord interaction is already bound to another VIP link.",
        );
      }
      return {
        status: operation.status,
        link: { ...preview, guildId: input.guildId, channelId: input.channelId },
      };
    }

    const channelResult = await tx.execute<LinkRow>(sql`
      SELECT guild_id, user_id, channel_id, linked_by_discord_user_id
      FROM discord_vip_channel_links
      WHERE guild_id = ${input.guildId}
        AND channel_id = ${input.channelId}
      FOR UPDATE
    `);
    const channelLink = channelResult.rows[0];
    if (channelLink && channelLink.user_id !== input.userId) {
      throw new VipChannelLinkError(
        409,
        "channel_link_conflict",
        "That Discord channel is already linked to another Packy user.",
      );
    }

    const userResult = await tx.execute<LinkRow>(sql`
      SELECT guild_id, user_id, channel_id, linked_by_discord_user_id
      FROM discord_vip_channel_links
      WHERE guild_id = ${input.guildId}
        AND user_id = ${input.userId}
      FOR UPDATE
    `);
    const existing = userResult.rows[0];
    const status =
      existing?.channel_id === input.channelId
        ? ("already_linked" as const)
        : existing
          ? ("updated" as const)
          : ("linked" as const);

    if (status === "linked") {
      await tx.execute(sql`
        INSERT INTO discord_vip_channel_links (
          guild_id,
          user_id,
          channel_id,
          linked_by_discord_user_id
        ) VALUES (
          ${input.guildId},
          ${input.userId},
          ${input.channelId},
          ${input.actorDiscordUserId}
        )
      `);
    } else if (status === "updated") {
      await tx.execute(sql`
        UPDATE discord_vip_channel_links
        SET
          channel_id = ${input.channelId},
          linked_by_discord_user_id = ${input.actorDiscordUserId},
          updated_at = NOW()
        WHERE guild_id = ${input.guildId}
          AND user_id = ${input.userId}
      `);
    }

    await tx.execute(sql`
      INSERT INTO discord_vip_channel_link_operations (
        interaction_id,
        guild_id,
        user_id,
        channel_id,
        actor_discord_user_id,
        status
      ) VALUES (
        ${input.interactionId},
        ${input.guildId},
        ${input.userId},
        ${input.channelId},
        ${input.actorDiscordUserId},
        ${status}
      )
    `);

    await tx.insert(admin_audit_events).values({
      event_type: "discord_vip_channel_linked",
      target_user_id: input.userId,
      metadata: {
        guildId: input.guildId,
        channelId: input.channelId,
        actorDiscordUserId: input.actorDiscordUserId,
        interactionId: input.interactionId,
        status,
        apiKeyId: input.apiKeyId,
        apiKeyPrefix: input.apiKeyPrefix,
      },
    });

    return {
      status,
      link: { ...preview, guildId: input.guildId, channelId: input.channelId },
    };
  });
}
