import "server-only";

import { sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import type { DiscordChannelCreationRequest } from "./channel-operations";
import { DISCORD_BOUNDARY_MARKERS } from "./antifraud-policy";
import { approvedCategoryIds } from "./policy-sql";

const SNOWFLAKE = /^\d{15,21}$/;
const EVENT_KEY = /^[a-z0-9][a-z0-9._-]{2,79}$/;

export type DiscordNotificationChannel = {
  id: string;
  name: string;
  type: string;
  parentId: string | null;
  parentName: string | null;
  position: number;
  canView: boolean;
  canSend: boolean;
  canEmbed: boolean;
};

export type DiscordNotificationEvent = {
  key: string;
  label: string;
  description: string;
  category: string;
  custom: boolean;
  enabled: boolean;
};

export type DiscordNotificationRoute = {
  id: string;
  eventKey: string;
  channelId: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type DiscordNotificationConfig = {
  guild: {
    id: string;
    name: string;
    connected: boolean;
    lastSyncedAt: string | null;
  };
  channels: DiscordNotificationChannel[];
  events: DiscordNotificationEvent[];
  routes: DiscordNotificationRoute[];
  channelCreation: {
    defaultParentId: string | null;
    recentRequests: DiscordChannelCreationRequest[];
  };
};

function requireSnowflake(value: string, field: string): string {
  const normalized = value.trim();
  if (!SNOWFLAKE.test(normalized)) {
    throw new Error(`${field} must be a Discord snowflake.`);
  }
  return normalized;
}

function normalizeEventKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!EVENT_KEY.test(normalized)) {
    throw new Error(
      "Event key must be 3-80 lowercase letters, numbers, dots, dashes, or underscores.",
    );
  }
  return normalized;
}

function boundedText(value: string, field: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new Error(`${field} must contain 1-${max} characters.`);
  }
  return normalized;
}

function configuredGuildId(guildId?: string): string {
  return requireSnowflake(
    guildId ?? process.env.ADMIN_GUILD_ID ?? "",
    "guildId",
  );
}

export async function getDiscordNotificationConfig(
  guildId?: string,
): Promise<DiscordNotificationConfig> {
  const id = configuredGuildId(guildId);
  const [
    guildResult,
    channelResult,
    eventResult,
    routeResult,
    settingsResult,
    creationResult,
  ] =
    await Promise.all([
      adminDrizzle.execute<{
        guild_id: string;
        name: string;
        connected: boolean;
        last_synced_at: string;
      }>(sql`
        SELECT guild_id, name, connected, last_synced_at::text
        FROM discord_notification_guilds
        WHERE guild_id = ${id}
        LIMIT 1
      `),
      adminDrizzle.execute<{
        channel_id: string;
        name: string;
        type: string;
        parent_id: string | null;
        parent_name: string | null;
        position: number;
        can_view: boolean;
        can_send: boolean;
        can_embed: boolean;
      }>(sql`
        SELECT
          channel_id, name, type, parent_id, parent_name, position,
          can_view, can_send, can_embed
        FROM discord_notification_channels
        WHERE guild_id = ${id} AND available = true
        ORDER BY position, name, channel_id
        LIMIT 1000
      `),
      adminDrizzle.execute<{
        event_key: string;
        label: string;
        description: string;
        category: string;
        is_custom: boolean;
        enabled: boolean;
      }>(sql`
        SELECT event_key, label, description, category, is_custom, enabled
        FROM discord_notification_events
        ORDER BY category, label, event_key
        LIMIT 500
      `),
      adminDrizzle.execute<{
        id: string;
        event_key: string;
        channel_id: string;
        enabled: boolean;
        created_at: string;
        updated_at: string;
      }>(sql`
        SELECT
          id::text, event_key, channel_id, enabled,
          created_at::text, updated_at::text
        FROM discord_notification_routes
        WHERE guild_id = ${id}
        ORDER BY event_key, created_at, id
        LIMIT 2000
      `),
      adminDrizzle.execute<{ default_parent_id: string | null }>(sql`
        SELECT default_parent_id
        FROM discord_notification_channel_settings
        WHERE guild_id = ${id}
        LIMIT 1
      `),
      adminDrizzle.execute<{
        id: string;
        parent_id: string;
        parent_name: string | null;
        requested_name: string;
        status: "pending" | "leased" | "created" | "dead";
        created_channel_id: string | null;
        created_channel_name: string | null;
        last_error_message: string | null;
        created_at: string;
        completed_at: string | null;
      }>(sql`
        SELECT
          job.id::text,
          job.parent_id,
          parent.name AS parent_name,
          job.requested_name,
          job.status,
          job.created_channel_id,
          job.created_channel_name,
          job.last_error_message,
          job.created_at::text,
          job.completed_at::text
        FROM discord_notification_channel_jobs AS job
        LEFT JOIN discord_notification_channels AS parent
          ON parent.guild_id = job.guild_id
         AND parent.channel_id = job.parent_id
        WHERE job.guild_id = ${id}
        ORDER BY job.created_at DESC, job.id DESC
        LIMIT 10
      `),
    ]);

  const guild = guildResult.rows[0];
  return {
    guild: {
      id,
      name: guild?.name ?? "Admin server",
      connected: guild?.connected ?? false,
      lastSyncedAt: guild?.last_synced_at ?? null,
    },
    channels: channelResult.rows.map((row) => ({
      id: row.channel_id,
      name: row.name,
      type: row.type,
      parentId: row.parent_id,
      parentName: row.parent_name,
      position: row.position,
      canView: row.can_view,
      canSend: row.can_send,
      canEmbed: row.can_embed,
    })),
    events: eventResult.rows.map((row) => ({
      key: row.event_key,
      label: row.label,
      description: row.description,
      category: row.category,
      custom: row.is_custom,
      enabled: row.enabled,
    })),
    routes: routeResult.rows.map((row) => ({
      id: row.id,
      eventKey: row.event_key,
      channelId: row.channel_id,
      enabled: row.enabled,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    channelCreation: {
      defaultParentId: settingsResult.rows[0]?.default_parent_id ?? null,
      recentRequests: creationResult.rows.map((row) => ({
        id: row.id,
        parentId: row.parent_id,
        parentName: row.parent_name,
        requestedName: row.requested_name,
        status: row.status,
        createdChannelId: row.created_channel_id,
        createdChannelName: row.created_channel_name,
        errorMessage: row.last_error_message,
        createdAt: row.created_at,
        completedAt: row.completed_at,
      })),
    },
  };
}

export async function createDiscordNotificationEvent(input: {
  key: string;
  label: string;
  description?: string;
  category: string;
  actorId: string;
}): Promise<DiscordNotificationEvent> {
  const key = normalizeEventKey(input.key);
  const label = boundedText(input.label, "Label", 120);
  const category = boundedText(input.category, "Category", 80);
  const description = input.description?.trim().slice(0, 500) ?? "";
  const result = await adminDrizzle.execute<{
    event_key: string;
    label: string;
    description: string;
    category: string;
    is_custom: boolean;
    enabled: boolean;
  }>(sql`
    INSERT INTO discord_notification_events (
      event_key, label, description, category, is_custom, enabled, created_by
    )
    VALUES (${key}, ${label}, ${description}, ${category}, true, true, ${input.actorId}::uuid)
    RETURNING event_key, label, description, category, is_custom, enabled
  `);
  const row = result.rows[0];
  if (!row) throw new Error("The custom event could not be created.");
  return {
    key: row.event_key,
    label: row.label,
    description: row.description,
    category: row.category,
    custom: row.is_custom,
    enabled: row.enabled,
  };
}

export async function upsertDiscordNotificationRoute(input: {
  guildId?: string;
  eventKey: string;
  channelId: string;
  enabled: boolean;
  actorId: string;
}): Promise<DiscordNotificationRoute> {
  const guildId = configuredGuildId(input.guildId);
  const eventKey = normalizeEventKey(input.eventKey);
  const channelId = requireSnowflake(input.channelId, "channelId");
  if (input.enabled) {
    // One event, one channel — the same claim rule the editor enforces. Only a
    // channel that still exists in the guild can hold a claim; a row left behind
    // by a deleted channel delivers nothing and must not block a reassignment.
    const taken = await adminDrizzle.execute<{ channel_id: string }>(sql`
      SELECT route.channel_id
      FROM discord_notification_routes AS route
      JOIN discord_notification_channels AS owner
        ON owner.guild_id = route.guild_id
       AND owner.channel_id = route.channel_id
       AND owner.available = true
      WHERE route.guild_id = ${guildId}
        AND route.event_key = ${eventKey}
        AND route.channel_id <> ${channelId}
      LIMIT 1
    `);
    if (taken.rows.length > 0) {
      throw new Error(
        "That event is already assigned to another channel. Remove it there first.",
      );
    }
  }
  const result = await adminDrizzle.execute<{
    id: string;
    event_key: string;
    channel_id: string;
    enabled: boolean;
    created_at: string;
    updated_at: string;
  }>(sql`
    INSERT INTO discord_notification_routes (
      guild_id, event_key, channel_id, enabled, created_by
    )
    SELECT ${guildId}, event.event_key, channel.channel_id, ${input.enabled}, ${input.actorId}::uuid
    FROM discord_notification_events AS event
    JOIN discord_notification_channels AS channel
      ON channel.guild_id = ${guildId}
     AND channel.channel_id = ${channelId}
     AND channel.available = true
     AND channel.can_view = true
     AND channel.can_send = true
     AND channel.can_embed = true
     AND channel.parent_id IN (
       ${approvedCategoryIds()}
     )
    JOIN discord_notification_channels AS parent
      ON parent.guild_id = channel.guild_id
     AND parent.channel_id = channel.parent_id
     AND parent.available = true
     AND parent.type = 'category'
    JOIN discord_notification_channels AS boundary_top
      ON boundary_top.guild_id = channel.guild_id
     AND boundary_top.channel_id = ${DISCORD_BOUNDARY_MARKERS.top}
     AND boundary_top.available = true
    JOIN discord_notification_channels AS boundary_bottom
      ON boundary_bottom.guild_id = channel.guild_id
     AND boundary_bottom.channel_id = ${DISCORD_BOUNDARY_MARKERS.bottom}
     AND boundary_bottom.available = true
    WHERE event.event_key = ${eventKey} AND event.enabled = true
      AND boundary_top.position < boundary_bottom.position
      AND parent.position > boundary_top.position
      AND parent.position < boundary_bottom.position
    ON CONFLICT (guild_id, event_key, channel_id) DO UPDATE SET
      enabled = EXCLUDED.enabled,
      updated_at = now()
    RETURNING
      id::text, event_key, channel_id, enabled,
      created_at::text, updated_at::text
  `);
  const row = result.rows[0];
  if (!row) {
    throw new Error(
      "The event or channel is unavailable, or the bot cannot send embeds there.",
    );
  }
  return {
    id: row.id,
    eventKey: row.event_key,
    channelId: row.channel_id,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function replaceDiscordNotificationChannelRoutes(input: {
  guildId?: string;
  channelId: string;
  eventKeys: string[];
  actorId: string;
}): Promise<void> {
  const guildId = configuredGuildId(input.guildId);
  const channelId = requireSnowflake(input.channelId, "channelId");
  const eventKeys = [...new Set(input.eventKeys.map(normalizeEventKey))];
  if (eventKeys.length !== input.eventKeys.length || eventKeys.length > 500) {
    throw new Error("Choose up to 500 unique events.");
  }
  const eventKeysJson = JSON.stringify(eventKeys);

  await adminDrizzle.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${guildId}, 0))
    `);

    const channelResult = await tx.execute<{ channel_id: string }>(sql`
      SELECT channel.channel_id
      FROM discord_notification_channels AS channel
      JOIN discord_notification_channels AS parent
        ON parent.guild_id = channel.guild_id
       AND parent.channel_id = channel.parent_id
       AND parent.available = true
       AND parent.type = 'category'
      JOIN discord_notification_channels AS boundary_top
        ON boundary_top.guild_id = channel.guild_id
       AND boundary_top.channel_id = ${DISCORD_BOUNDARY_MARKERS.top}
       AND boundary_top.available = true
      JOIN discord_notification_channels AS boundary_bottom
        ON boundary_bottom.guild_id = channel.guild_id
       AND boundary_bottom.channel_id = ${DISCORD_BOUNDARY_MARKERS.bottom}
       AND boundary_bottom.available = true
      WHERE channel.guild_id = ${guildId}
        AND channel.channel_id = ${channelId}
        AND channel.available = true
        AND channel.parent_id IN (
          ${approvedCategoryIds()}
        )
        AND boundary_top.position < boundary_bottom.position
        AND parent.position > boundary_top.position
        AND parent.position < boundary_bottom.position
      LIMIT 1
      FOR UPDATE
    `);
    if (channelResult.rows.length !== 1) {
      throw new Error("That Discord channel is no longer available.");
    }

    if (eventKeys.length > 0) {
      // A row pointing at a channel the guild no longer has cannot receive
      // anything, so it is cleared instead of blocking this assignment. The
      // advisory lock above serializes this per guild.
      await tx.execute(sql`
        DELETE FROM discord_notification_routes AS route
        WHERE route.guild_id = ${guildId}
          AND route.channel_id <> ${channelId}
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(${eventKeysJson}::jsonb) AS desired(event_key)
            WHERE desired.event_key = route.event_key
          )
          AND NOT EXISTS (
            SELECT 1
            FROM discord_notification_channels AS owner
            WHERE owner.guild_id = route.guild_id
              AND owner.channel_id = route.channel_id
              AND owner.available = true
          )
      `);

      // An event belongs to exactly one live channel. The advisory lock above
      // serializes per guild, so this claim check cannot be raced.
      const taken = await tx.execute<{ event_key: string }>(sql`
        SELECT route.event_key
        FROM discord_notification_routes AS route
        JOIN jsonb_array_elements_text(${eventKeysJson}::jsonb) AS desired(event_key)
          ON desired.event_key = route.event_key
        WHERE route.guild_id = ${guildId}
          AND route.channel_id <> ${channelId}
      `);
      if (taken.rows.length > 0) {
        const claimed = [...new Set(taken.rows.map((row) => row.event_key))];
        throw new Error(
          `Already assigned to another channel: ${claimed.join(", ")}. Remove it there first.`,
        );
      }

      const inserted = await tx.execute<{ event_key: string }>(sql`
        INSERT INTO discord_notification_routes (
          guild_id, event_key, channel_id, enabled, created_by
        )
        SELECT
          ${guildId}, event.event_key, channel.channel_id, true, ${input.actorId}::uuid
        FROM jsonb_array_elements_text(${eventKeysJson}::jsonb) AS desired(event_key)
        JOIN discord_notification_events AS event
          ON event.event_key = desired.event_key
         AND event.enabled = true
        JOIN discord_notification_channels AS channel
          ON channel.guild_id = ${guildId}
         AND channel.channel_id = ${channelId}
         AND channel.available = true
         AND channel.can_view = true
         AND channel.can_send = true
         AND channel.can_embed = true
         AND channel.parent_id IN (
           ${approvedCategoryIds()}
         )
        JOIN discord_notification_channels AS parent
          ON parent.guild_id = channel.guild_id
         AND parent.channel_id = channel.parent_id
         AND parent.available = true
         AND parent.type = 'category'
        JOIN discord_notification_channels AS boundary_top
          ON boundary_top.guild_id = channel.guild_id
         AND boundary_top.channel_id = ${DISCORD_BOUNDARY_MARKERS.top}
         AND boundary_top.available = true
        JOIN discord_notification_channels AS boundary_bottom
          ON boundary_bottom.guild_id = channel.guild_id
         AND boundary_bottom.channel_id = ${DISCORD_BOUNDARY_MARKERS.bottom}
         AND boundary_bottom.available = true
        WHERE boundary_top.position < boundary_bottom.position
          AND parent.position > boundary_top.position
          AND parent.position < boundary_bottom.position
        ON CONFLICT (guild_id, event_key, channel_id) DO UPDATE SET
          enabled = true,
          updated_at = now()
        RETURNING event_key
      `);
      if (inserted.rows.length !== eventKeys.length) {
        throw new Error(
          "One or more events are unavailable, or the bot cannot send embeds to that channel.",
        );
      }
    }

    await tx.execute(sql`
      DELETE FROM discord_notification_routes AS route
      WHERE route.guild_id = ${guildId}
        AND route.channel_id = ${channelId}
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(${eventKeysJson}::jsonb) AS desired(event_key)
          WHERE desired.event_key = route.event_key
        )
    `);
  });
}

export async function setDiscordNotificationRouteEnabled(input: {
  guildId?: string;
  id: string;
  enabled: boolean;
}): Promise<void> {
  const guildId = configuredGuildId(input.guildId);
  const result = await adminDrizzle.execute<{ id: string }>(sql`
    UPDATE discord_notification_routes
    SET enabled = ${input.enabled}, updated_at = now()
    WHERE id = ${input.id}::uuid AND guild_id = ${guildId}
    RETURNING id::text
  `);
  if (result.rows.length !== 1) throw new Error("Notification route not found.");
}

export async function deleteDiscordNotificationRoute(input: {
  guildId?: string;
  id: string;
}): Promise<void> {
  const guildId = configuredGuildId(input.guildId);
  const result = await adminDrizzle.execute<{ id: string }>(sql`
    DELETE FROM discord_notification_routes
    WHERE id = ${input.id}::uuid AND guild_id = ${guildId}
    RETURNING id::text
  `);
  if (result.rows.length !== 1) throw new Error("Notification route not found.");
}
