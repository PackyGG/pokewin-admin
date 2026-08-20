import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import {
  admin_audit_events,
  admin_user_tags,
} from "@/lib/db-schema/admin/schema";
import { user } from "@/lib/db-schema/main/schema";
import { getProdReadDrizzleDb } from "@/lib/db";
import { isDiscordDashboardOperator } from "@/lib/discord-dashboard-operators";

export const VIPS_GUILD_ID = "1505650386894327919";

export type VipLinkUserPreview = {
  userId: string;
  username: string | null;
  displayUsername: string | null;
  hasVipTag: boolean;
};

export type VipChannelLink = VipLinkUserPreview & {
  guildId: string;
  channelId: string;
  memberDiscordUserId: string | null;
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
  member_discord_user_id: string | null;
  linked_by_discord_user_id: string;
};

type OperationRow = {
  interaction_id: string;
  guild_id: string;
  user_id: string;
  channel_id: string;
  member_discord_user_id: string | null;
  actor_discord_user_id: string;
  status: "linked" | "updated" | "already_linked";
  vip_tag_added: boolean;
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
  const [vipTag] = await adminDrizzle
    .select({ id: admin_user_tags.id })
    .from(admin_user_tags)
    .where(and(
      eq(admin_user_tags.target_user_id, userId),
      eq(admin_user_tags.tag, "vip"),
    ))
    .limit(1);
  return { ...found, hasVipTag: Boolean(vipTag) };
}

export async function previewVipChannelLink(
  userId: string,
): Promise<VipLinkUserPreview> {
  return requireUser(userId);
}

export async function getVipDashboardContext(input: {
  guildId: string;
  channelId: string;
  actorDiscordUserId: string;
}): Promise<{ userId: string }> {
  if (!isDiscordDashboardOperator(input.actorDiscordUserId)) {
    throw new VipChannelLinkError(
      403,
      "dashboard_actor_forbidden",
      "Only an authorized dashboard operator can open VIP accounts.",
    );
  }

  const result = await adminDrizzle.execute<{ user_id: string }>(sql`
    SELECT user_id
    FROM discord_vip_channel_links
    WHERE guild_id = ${input.guildId}
      AND channel_id = ${input.channelId}
    LIMIT 1
  `);
  const link = result.rows[0];
  if (!link) {
    throw new VipChannelLinkError(
      404,
      "vip_channel_not_linked",
      "This VIP channel is not linked to a Packy account yet.",
    );
  }
  return { userId: link.user_id };
}

export async function saveVipChannelLink(input: {
  guildId: string;
  channelId: string;
  memberDiscordUserId: string | null;
  userId: string;
  actorDiscordUserId: string;
  interactionId: string;
  apiKeyId: string;
  apiKeyPrefix: string;
}): Promise<{
  status: "linked" | "updated" | "already_linked";
  link: VipChannelLink;
  vipTagAdded: boolean;
}> {
  const preview = await requireUser(input.userId);

  return adminDrizzle.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`discord-vip-link-interaction:${input.interactionId}`}, 0)
      )
    `);
    const resourceLocks = [
      `discord-vip-link-resource:${input.guildId}:channel:${input.channelId}`,
      `discord-vip-link-resource:${input.guildId}:user:${input.userId}`,
      input.memberDiscordUserId
        ? `discord-vip-link-resource:${input.guildId}:member:${input.memberDiscordUserId}`
        : null,
    ].filter((value): value is string => Boolean(value)).sort();
    for (const resourceLock of resourceLocks) {
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${resourceLock}, 0)
        )
      `);
    }

    const operationResult = await tx.execute<OperationRow>(sql`
      SELECT
        interaction_id,
        guild_id,
        user_id,
        channel_id,
        member_discord_user_id,
        actor_discord_user_id,
        status,
        vip_tag_added
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
        operation.member_discord_user_id !== input.memberDiscordUserId ||
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
        link: {
          ...preview,
          hasVipTag: true,
          guildId: input.guildId,
          channelId: input.channelId,
          memberDiscordUserId: input.memberDiscordUserId,
        },
        vipTagAdded: operation.vip_tag_added,
      };
    }

    const channelResult = await tx.execute<LinkRow>(sql`
      SELECT guild_id, user_id, channel_id, member_discord_user_id,
        linked_by_discord_user_id
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

    const memberLink = input.memberDiscordUserId
      ? (await tx.execute<LinkRow>(sql`
          SELECT guild_id, user_id, channel_id, member_discord_user_id,
            linked_by_discord_user_id
          FROM discord_vip_channel_links
          WHERE guild_id = ${input.guildId}
            AND member_discord_user_id = ${input.memberDiscordUserId}
          FOR UPDATE
        `)).rows[0]
      : undefined;
    if (
      memberLink
      && (
        memberLink.user_id !== input.userId
        || memberLink.channel_id !== input.channelId
      )
    ) {
      throw new VipChannelLinkError(
        409,
        "discord_member_link_conflict",
        "That Discord member is already linked to another VIP channel or Packy user.",
      );
    }

    const userResult = await tx.execute<LinkRow>(sql`
      SELECT guild_id, user_id, channel_id, member_discord_user_id,
        linked_by_discord_user_id
      FROM discord_vip_channel_links
      WHERE guild_id = ${input.guildId}
        AND user_id = ${input.userId}
      FOR UPDATE
    `);
    const existing = userResult.rows[0];
    const status =
      existing?.channel_id === input.channelId
        && existing?.member_discord_user_id === input.memberDiscordUserId
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
          member_discord_user_id,
          linked_by_discord_user_id
        ) VALUES (
          ${input.guildId},
          ${input.userId},
          ${input.channelId},
          ${input.memberDiscordUserId},
          ${input.actorDiscordUserId}
        )
      `);
    } else if (status === "updated") {
      await tx.execute(sql`
        UPDATE discord_vip_channel_links
        SET
          channel_id = ${input.channelId},
          member_discord_user_id = ${input.memberDiscordUserId},
          linked_by_discord_user_id = ${input.actorDiscordUserId},
          updated_at = NOW()
        WHERE guild_id = ${input.guildId}
          AND user_id = ${input.userId}
      `);
    }

    // Membership and perk access are separate, but every durable link owns a
    // qualification clock. Preserve the original link timestamp forever;
    // channel/member updates must not silently grant another 30 days.
    await tx.execute(sql`
      INSERT INTO vip_perk_entitlements (link_id, initial_window_started_at)
      SELECT id, created_at
      FROM discord_vip_channel_links
      WHERE guild_id = ${input.guildId}
        AND user_id = ${input.userId}
      ON CONFLICT (link_id) DO NOTHING
    `);

    const vipTagResult = await tx.execute<{ id: string }>(sql`
      INSERT INTO admin_user_tags (target_user_id, tag)
      VALUES (${input.userId}, 'vip')
      ON CONFLICT (target_user_id, tag) DO NOTHING
      RETURNING id
    `);
    const vipTagAdded = vipTagResult.rows.length > 0;

    await tx.execute(sql`
      INSERT INTO discord_vip_channel_link_operations (
        interaction_id,
        guild_id,
        user_id,
        channel_id,
        member_discord_user_id,
        actor_discord_user_id,
        status,
        vip_tag_added
      ) VALUES (
        ${input.interactionId},
        ${input.guildId},
        ${input.userId},
        ${input.channelId},
        ${input.memberDiscordUserId},
        ${input.actorDiscordUserId},
        ${status},
        ${vipTagAdded}
      )
    `);

    await tx.insert(admin_audit_events).values({
      event_type: "discord_vip_channel_linked",
      target_user_id: input.userId,
      metadata: {
        guildId: input.guildId,
        channelId: input.channelId,
        memberDiscordUserId: input.memberDiscordUserId,
        actorDiscordUserId: input.actorDiscordUserId,
        interactionId: input.interactionId,
        status,
        vipTagAdded,
        apiKeyId: input.apiKeyId,
        apiKeyPrefix: input.apiKeyPrefix,
      },
    });

    return {
      status,
      link: {
        ...preview,
        hasVipTag: true,
        guildId: input.guildId,
        channelId: input.channelId,
        memberDiscordUserId: input.memberDiscordUserId,
      },
      vipTagAdded,
    };
  });
}
