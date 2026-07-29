import "server-only";

import { sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";

const SNOWFLAKE = /^\d{15,21}$/;
const EVENT_KEY = /^[a-z0-9][a-z0-9._-]{2,79}$/;

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
  content?: string;
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

export async function enqueueDiscordEvent(input: {
  guildId: string;
  eventKey: string;
  dedupeKey: string;
  embed: Record<string, unknown>;
  content?: string;
}): Promise<{ enqueued: number; duplicate: number }> {
  const guildId = snowflake(input.guildId, "guildId");
  const key = eventKey(input.eventKey);
  const dedupeKey = input.dedupeKey.trim();
  if (!dedupeKey || dedupeKey.length > 200) {
    throw new Error("dedupeKey must contain 1-200 characters.");
  }
  const content = input.content?.trim().slice(0, 2000) || null;
  const embedJson = JSON.stringify(input.embed);
  if (embedJson.length > 24_000) throw new Error("embed is too large.");

  const result = await adminDrizzle.execute<{ inserted: number; eligible: number }>(
    sql`
      WITH eligible AS (
        SELECT route.channel_id
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
        WHERE route.guild_id = ${guildId}
          AND route.event_key = ${key}
          AND route.enabled = true
      ),
      inserted AS (
        INSERT INTO discord_notification_jobs (
          guild_id, event_key, channel_id, dedupe_key, content, embed
        )
        SELECT
          ${guildId}, ${key}, eligible.channel_id, ${dedupeKey}, ${content},
          ${embedJson}::jsonb
        FROM eligible
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
    content: string | null;
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
      job.content,
      job.created_at::text,
      job.attempt_count
  `);

  return result.rows.map((row) => ({
    id: row.id,
    leaseToken: row.lease_token,
    eventKey: row.event_key,
    channelId: row.channel_id,
    embed: row.embed,
    ...(row.content ? { content: row.content } : {}),
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
