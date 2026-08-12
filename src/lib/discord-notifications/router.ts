import "server-only";

import { sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import {
  DISCORD_BOUNDARY_MARKERS,
  assertApprovedCategoryBoundary,
  discordEventMentionGroupOverride,
} from "./antifraud-policy";
import {
  approvedCategoryIds,
  mentionGroupKeyRows,
  mentionGroupMemberRows,
  silentCategoryIds,
} from "./policy-sql";
import { ensureDiscordLinkButton } from "./link-button";

const SNOWFLAKE = /^\d{15,21}$/;
const EVENT_KEY = /^[a-z0-9][a-z0-9._-]{2,79}$/;

const ERROR_EVENT_KEYS = {
  webapp: "antifraud.error.webapp",
  thirdPartyApi: "antifraud.error.third_party_api",
  discord: "antifraud.error.discord_command",
  general: "antifraud.error.general",
} as const;

/** Keep every operational error on one of the four live error routes. */
export function canonicalDiscordEventKey(value: string): string {
  const normalized = eventKey(value);
  if (Object.values(ERROR_EVENT_KEYS).includes(
    normalized as (typeof ERROR_EVENT_KEYS)[keyof typeof ERROR_EVENT_KEYS],
  )) {
    return normalized;
  }
  if (normalized === "antifraud.error.code") {
    return ERROR_EVENT_KEYS.webapp;
  }
  if (normalized === "antifraud.error.provider_access") {
    return ERROR_EVENT_KEYS.thirdPartyApi;
  }
  if (normalized.startsWith("antifraud.error.")) {
    return ERROR_EVENT_KEYS.general;
  }
  return normalized;
}

export type SyncedDiscordChannel = {
  id: string;
  name: string;
  type: string;
  parentId: string | null;
  parentName?: string | null;
  position: number;
  canView: boolean;
  canSend: boolean;
  canEmbed: boolean;
};

export type DiscordDeliveryJob = {
  id: string;
  leaseToken: string;
  eventKey: string;
  channelId: string;
  embed: Record<string, unknown>;
  components: Array<Record<string, unknown>>;
  content?: string;
  /**
   * The mention allowlist the delivering bot must pass to Discord verbatim.
   * Always present, always `parse: []`, so alert text can never produce an
   * @everyone, @here, or role ping.
   */
  allowedMentions: Record<string, unknown>;
  createdAt: string;
  attempt: number;
};

function snowflake(value: string, field: string): string {
  const normalized = value.trim();
  if (!SNOWFLAKE.test(normalized)) {
    throw new Error(`${field} must be a Discord snowflake.`);
  }
  return normalized;
}

function eventKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!EVENT_KEY.test(normalized)) throw new Error("Invalid eventKey.");
  return normalized;
}

export async function syncDiscordChannels(input: {
  guildId: string;
  guildName: string;
  channels: readonly SyncedDiscordChannel[];
  syncedAt: Date;
}): Promise<{ channels: number }> {
  const guildId = snowflake(input.guildId, "guildId");
  const guildName = input.guildName.trim().slice(0, 120);
  if (!guildName) throw new Error("guildName is required.");
  if (input.channels.length > 1000) throw new Error("Too many channels.");

  const unique = new Map<string, SyncedDiscordChannel>();
  for (const channel of input.channels) {
    const id = snowflake(channel.id, "channel.id");
    if (unique.has(id)) throw new Error("Duplicate channel id.");
    unique.set(id, {
      ...channel,
      id,
      name: channel.name.trim().slice(0, 120) || "Unnamed channel",
      type: channel.type.trim().slice(0, 40) || "unknown",
      parentId: channel.parentId
        ? snowflake(channel.parentId, "channel.parentId")
        : null,
      parentName: channel.parentName?.trim().slice(0, 120) || null,
      position: Math.max(-1, Math.min(100000, Math.trunc(channel.position))),
    });
  }
  assertApprovedCategoryBoundary([...unique.values()]);
  const channelsJson = JSON.stringify([...unique.values()]);

  await adminDrizzle.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO discord_notification_guilds (
        guild_id, name, connected, last_synced_at
      )
      VALUES (${guildId}, ${guildName}, true, ${input.syncedAt.toISOString()}::timestamptz)
      ON CONFLICT (guild_id) DO UPDATE SET
        name = EXCLUDED.name,
        connected = true,
        last_synced_at = EXCLUDED.last_synced_at,
        updated_at = now()
    `);
    await tx.execute(sql`
      UPDATE discord_notification_channels
      SET available = false, updated_at = now()
      WHERE guild_id = ${guildId}
    `);
    await tx.execute(sql`
      INSERT INTO discord_notification_channels (
        guild_id, channel_id, name, type, parent_id, parent_name, position,
        can_view, can_send, can_embed, available, last_synced_at
      )
      SELECT
        ${guildId},
        source.id,
        source.name,
        source.type,
        source."parentId",
        source."parentName",
        source.position,
        source."canView",
        source."canSend",
        source."canEmbed",
        true,
        ${input.syncedAt.toISOString()}::timestamptz
      FROM jsonb_to_recordset(${channelsJson}::jsonb) AS source(
        id text,
        name text,
        type text,
        "parentId" text,
        "parentName" text,
        position integer,
        "canView" boolean,
        "canSend" boolean,
        "canEmbed" boolean
      )
      ON CONFLICT (guild_id, channel_id) DO UPDATE SET
        name = EXCLUDED.name,
        type = EXCLUDED.type,
        parent_id = EXCLUDED.parent_id,
        parent_name = EXCLUDED.parent_name,
        position = EXCLUDED.position,
        can_view = EXCLUDED.can_view,
        can_send = EXCLUDED.can_send,
        can_embed = EXCLUDED.can_embed,
        available = true,
        last_synced_at = EXCLUDED.last_synced_at,
        updated_at = now()
    `);
  });

  return { channels: unique.size };
}

/**
 * Queues one alert onto every channel the event is routed to.
 *
 * WHO GETS TAGGED IS DECIDED HERE, not by the caller. Each channel selects its
 * own mention groups (`discord_notification_channel_mentions`) and this query
 * resolves them to Discord user ids per channel. Producers previously passed a
 * pre-rendered `content` string, which meant one hardcoded tag list applied to
 * every destination and operators could not change it without a deploy.
 *
 * Alert severity never changes recipients. Normally the channel's saved
 * selection is the complete tag list. A small reviewed event override may
 * narrow that list for a dedicated workflow; it can never broaden it based on
 * severity or producer-controlled payload data.
 */
export async function enqueueDiscordEvent(input: {
  guildId: string;
  eventKey: string;
  dedupeKey: string;
  embed: Record<string, unknown>;
  components?: Array<Record<string, unknown>>;
}): Promise<{ enqueued: number; duplicate: number }> {
  const guildId = snowflake(input.guildId, "guildId");
  const key = canonicalDiscordEventKey(input.eventKey);
  const dedupeKey = input.dedupeKey.trim();
  if (!dedupeKey || dedupeKey.length > 200) {
    throw new Error("dedupeKey must contain 1-200 characters.");
  }
  const embedJson = JSON.stringify(input.embed);
  if (embedJson.length > 24_000) throw new Error("embed is too large.");
  const componentsJson = JSON.stringify(
    ensureDiscordLinkButton(input.embed, input.components),
  );
  if (componentsJson.length > 8_000) {
    throw new Error("components are too large.");
  }
  const mentionGroupOverride = discordEventMentionGroupOverride(key);
  const channelGroupsQuery = mentionGroupOverride
    ? sql`
        SELECT eligible.channel_id, required.group_key
        FROM eligible
        CROSS JOIN (VALUES ${mentionGroupKeyRows(mentionGroupOverride)})
          AS required(group_key)
      `
    : sql`
        SELECT eligible.channel_id, selection.group_key
        FROM eligible
        JOIN discord_notification_channel_mentions AS selection
          ON selection.guild_id = ${guildId}
         AND selection.channel_id = eligible.channel_id
      `;

  const result = await adminDrizzle.execute<{ inserted: number; eligible: number }>(
    sql`
      WITH eligible AS (
        SELECT route.channel_id, channel.parent_id
        FROM discord_notification_routes AS route
        JOIN discord_notification_events AS event
          ON event.event_key = route.event_key
         AND event.enabled = true
        JOIN discord_notification_channels AS channel
          ON channel.guild_id = route.guild_id
         AND channel.channel_id = route.channel_id
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
        WHERE route.guild_id = ${guildId}
          AND route.event_key = ${key}
          AND route.enabled = true
          AND boundary_top.position < boundary_bottom.position
          AND parent.position > boundary_top.position
          AND parent.position < boundary_bottom.position
      ),
      -- The operator's saved selection is the complete recipient policy for
      -- each channel unless the event has a narrower reviewed override.
      -- Reward-abuse batches, for example, notify Support only even when the
      -- shared destination channel selects additional teams.
      channel_groups AS (
        ${channelGroupsQuery}
      ),
      -- DISTINCT on the id, not the group: one teammate can sit in two selected
      -- groups and must still be tagged exactly once.
      mentions AS (
        SELECT
          channel_groups.channel_id,
          string_agg(
            DISTINCT '<@' || member.user_id || '>',
            ' '
            ORDER BY '<@' || member.user_id || '>'
          ) AS content,
          jsonb_agg(DISTINCT member.user_id) AS user_ids
        FROM channel_groups
        JOIN (VALUES ${mentionGroupMemberRows()})
          AS member(group_key, user_id)
          ON member.group_key = channel_groups.group_key
        GROUP BY channel_groups.channel_id
      ),
      inserted AS (
        INSERT INTO discord_notification_jobs (
          guild_id, event_key, channel_id, dedupe_key, content, embed,
          components, allowed_mentions
        )
        SELECT
          ${guildId}, ${key}, eligible.channel_id, ${dedupeKey},
          -- Errors and KYC channels post silently: their mention content is
          -- dropped here so no routing change can reintroduce a ping.
          CASE
            WHEN eligible.parent_id IN (${silentCategoryIds()}) THEN NULL
            ELSE mentions.content
          END,
          ${embedJson}::jsonb, ${componentsJson}::jsonb,
          -- The allowlist travels with the job so the delivering bot can pin
          -- allowed_mentions to exactly these ids. An empty parse list blocks
          -- @everyone/@here and role pings even if the text ever contained one.
          CASE
            WHEN eligible.parent_id IN (${silentCategoryIds()})
              OR mentions.user_ids IS NULL
            THEN jsonb_build_object('parse', '[]'::jsonb)
            ELSE jsonb_build_object(
              'parse', '[]'::jsonb,
              'users', mentions.user_ids
            )
          END
        FROM eligible
        LEFT JOIN mentions ON mentions.channel_id = eligible.channel_id
        ON CONFLICT (guild_id, event_key, dedupe_key, channel_id) DO NOTHING
        RETURNING 1
      )
      SELECT
        (SELECT count(*)::int FROM inserted) AS inserted,
        (SELECT count(*)::int FROM eligible) AS eligible
    `,
  );
  const row = result.rows[0] ?? { inserted: 0, eligible: 0 };
  return {
    enqueued: row.inserted,
    duplicate: Math.max(0, row.eligible - row.inserted),
  };
}

export async function claimDiscordJobs(input: {
  guildId: string;
  workerId: string;
  limit: number;
}): Promise<DiscordDeliveryJob[]> {
  const guildId = snowflake(input.guildId, "guildId");
  const workerId = input.workerId.trim().slice(0, 120);
  if (!workerId) throw new Error("workerId is required.");
  const limit = Math.max(1, Math.min(25, Math.trunc(input.limit)));

  const result = await adminDrizzle.execute<{
    id: string;
    lease_token: string;
    event_key: string;
    channel_id: string;
    embed: Record<string, unknown>;
    components: Array<Record<string, unknown>>;
    content: string | null;
    allowed_mentions: Record<string, unknown> | null;
    created_at: string;
    attempt_count: number;
  }>(sql`
    WITH exhausted AS (
      UPDATE discord_notification_jobs
      SET
        status = 'dead',
        lease_token = NULL,
        lease_owner = NULL,
        leased_until = NULL,
        last_error_code = COALESCE(last_error_code, 'lease_expired'),
        last_error_message = COALESCE(
          last_error_message,
          'The final delivery lease expired before acknowledgement.'
        ),
        updated_at = now()
      WHERE guild_id = ${guildId}
        AND status = 'leased'
        AND leased_until < now()
        AND attempt_count >= max_attempts
      RETURNING id
    ),
    candidates AS (
      SELECT id
      FROM discord_notification_jobs
      WHERE guild_id = ${guildId}
        AND available_at <= now()
        AND attempt_count < max_attempts
        AND (
          status = 'pending'
          OR (status = 'leased' AND leased_until < now())
        )
      ORDER BY available_at, created_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    UPDATE discord_notification_jobs AS job
    SET
      status = 'leased',
      attempt_count = job.attempt_count + 1,
      lease_token = gen_random_uuid(),
      lease_owner = ${workerId},
      leased_until = now() + interval '60 seconds',
      updated_at = now()
    FROM candidates
    WHERE job.id = candidates.id
    RETURNING
      job.id::text,
      job.lease_token::text,
      job.event_key,
      job.channel_id,
      job.embed,
      job.components,
      job.content,
      job.allowed_mentions,
      job.created_at::text,
      job.attempt_count
  `);

  return result.rows.map((row) => ({
    id: row.id,
    leaseToken: row.lease_token,
    eventKey: row.event_key,
    channelId: row.channel_id,
    embed: row.embed,
    components: row.components,
    ...(row.content ? { content: row.content } : {}),
    // Jobs queued before the allowlist column existed fall back to the
    // strictest value rather than letting Discord parse the text.
    allowedMentions: row.allowed_mentions ?? { parse: [] },
    createdAt: row.created_at,
    attempt: row.attempt_count,
  }));
}

export async function acknowledgeDiscordJob(input: {
  id: string;
  leaseToken: string;
  guildId: string;
  status: "delivered" | "failed";
  discordMessageId?: string;
  errorCode?: string;
  errorMessage?: string;
}): Promise<{ status: "delivered" | "pending" | "dead" }> {
  const guildId = snowflake(input.guildId, "guildId");
  if (input.status === "delivered") {
    const result = await adminDrizzle.execute<{ status: "delivered" }>(sql`
      UPDATE discord_notification_jobs
      SET
        status = 'delivered',
        discord_message_id = ${input.discordMessageId?.trim().slice(0, 30) || null},
        delivered_at = COALESCE(delivered_at, now()),
        leased_until = NULL,
        last_error_code = NULL,
        last_error_message = NULL,
        updated_at = now()
      WHERE id = ${input.id}::uuid
        AND guild_id = ${guildId}
        AND lease_token = ${input.leaseToken}::uuid
        AND status IN ('leased', 'delivered')
      RETURNING status
    `);
    if (result.rows.length !== 1) throw new Error("Lease not found.");
    return { status: "delivered" };
  }

  const result = await adminDrizzle.execute<{
    status: "pending" | "dead";
  }>(sql`
    UPDATE discord_notification_jobs
    SET
      status = CASE
        WHEN attempt_count >= max_attempts THEN 'dead'
        ELSE 'pending'
      END,
      available_at = now() + (
        LEAST(300, power(2, LEAST(attempt_count, 8))::int) * interval '1 second'
      ),
      lease_token = NULL,
      lease_owner = NULL,
      leased_until = NULL,
      last_error_code = ${input.errorCode?.trim().slice(0, 80) || null},
      last_error_message = ${input.errorMessage?.trim().slice(0, 500) || null},
      updated_at = now()
    WHERE id = ${input.id}::uuid
      AND guild_id = ${guildId}
      AND lease_token = ${input.leaseToken}::uuid
      AND status = 'leased'
    RETURNING status
  `);
  const row = result.rows[0];
  if (!row) throw new Error("Lease not found.");
  return { status: row.status };
}
