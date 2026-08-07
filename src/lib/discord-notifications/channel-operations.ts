import "server-only";

import { sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { DISCORD_BOUNDARY_MARKERS } from "./antifraud-policy";
import { approvedCategoryIds } from "./policy-sql";

const SNOWFLAKE = /^\d{15,21}$/;

export type DiscordChannelCreationJob = {
  id: string;
  leaseToken: string;
  parentId: string;
  name: string;
  createdAt: string;
  attempt: number;
};

export type DiscordChannelCreationRequest = {
  id: string;
  parentId: string;
  parentName: string | null;
  requestedName: string;
  status: "pending" | "leased" | "created" | "dead";
  createdChannelId: string | null;
  createdChannelName: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
};

function snowflake(value: string, field: string): string {
  const normalized = value.trim();
  if (!SNOWFLAKE.test(normalized)) {
    throw new Error(`${field} must be a Discord snowflake.`);
  }
  return normalized;
}

function guildId(value?: string): string {
  return snowflake(value ?? process.env.ADMIN_GUILD_ID ?? "", "guildId");
}

function normalizeDiscordChannelName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100)
    .replace(/-$/g, "");
  if (!normalized) {
    throw new Error("Channel name must include a letter or number.");
  }
  return normalized;
}

export async function queueDiscordChannelCreation(input: {
  guildId?: string;
  parentId: string;
  name: string;
  actorId: string;
}): Promise<{ id: string; name: string }> {
  const configuredGuildId = guildId(input.guildId);
  const parentId = snowflake(input.parentId, "parentId");
  const name = normalizeDiscordChannelName(input.name);

  return adminDrizzle.transaction(async (tx) => {
    const parent = await tx.execute<{ channel_id: string }>(sql`
      SELECT parent.channel_id
      FROM discord_notification_channels AS parent
      JOIN discord_notification_channels AS boundary_top
        ON boundary_top.guild_id = parent.guild_id
       AND boundary_top.channel_id = ${DISCORD_BOUNDARY_MARKERS.top}
       AND boundary_top.available = true
      JOIN discord_notification_channels AS boundary_bottom
        ON boundary_bottom.guild_id = parent.guild_id
       AND boundary_bottom.channel_id = ${DISCORD_BOUNDARY_MARKERS.bottom}
       AND boundary_bottom.available = true
      WHERE parent.guild_id = ${configuredGuildId}
        AND parent.channel_id = ${parentId}
        AND parent.available = true
        AND parent.type = 'category'
        AND parent.can_view = true
        AND parent.position > boundary_top.position
        AND parent.position < boundary_bottom.position
        AND boundary_top.position < boundary_bottom.position
        AND parent.channel_id IN (
          ${approvedCategoryIds()}
        )
      LIMIT 1
      FOR UPDATE
    `);
    if (parent.rows.length !== 1) {
      throw new Error("Choose an available Discord category.");
    }

    await tx.execute(sql`
      INSERT INTO discord_notification_channel_settings (
        guild_id, default_parent_id, updated_by
      )
      VALUES (
        ${configuredGuildId}, ${parentId}, ${input.actorId}::uuid
      )
      ON CONFLICT (guild_id) DO UPDATE SET
        default_parent_id = EXCLUDED.default_parent_id,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
    `);

    const result = await tx.execute<{ id: string }>(sql`
      INSERT INTO discord_notification_channel_jobs (
        guild_id, parent_id, requested_name, created_by
      )
      VALUES (
        ${configuredGuildId}, ${parentId}, ${name}, ${input.actorId}::uuid
      )
      RETURNING id::text
    `);
    const row = result.rows[0];
    if (!row) throw new Error("The channel creation request could not be queued.");
    return { id: row.id, name };
  });
}

export async function claimDiscordChannelCreationJobs(input: {
  guildId: string;
  workerId: string;
  limit: number;
}): Promise<DiscordChannelCreationJob[]> {
  const configuredGuildId = guildId(input.guildId);
  const workerId = input.workerId.trim().slice(0, 120);
  if (!workerId) throw new Error("workerId is required.");
  const limit = Math.max(1, Math.min(10, Math.trunc(input.limit)));

  const result = await adminDrizzle.execute<{
    id: string;
    lease_token: string;
    parent_id: string;
    requested_name: string;
    created_at: string;
    attempt_count: number;
  }>(sql`
    WITH exhausted AS (
      UPDATE discord_notification_channel_jobs
      SET
        status = 'dead',
        lease_token = NULL,
        lease_owner = NULL,
        leased_until = NULL,
        completed_at = COALESCE(completed_at, now()),
        last_error_code = COALESCE(last_error_code, 'lease_expired'),
        last_error_message = COALESCE(
          last_error_message,
          'The final channel-creation lease expired before acknowledgement.'
        ),
        updated_at = now()
      WHERE guild_id = ${configuredGuildId}
        AND status = 'leased'
        AND leased_until < now()
        AND attempt_count >= max_attempts
      RETURNING id
    ),
    candidates AS (
      SELECT id
      FROM discord_notification_channel_jobs
      WHERE guild_id = ${configuredGuildId}
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
    UPDATE discord_notification_channel_jobs AS job
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
      job.parent_id,
      job.requested_name,
      job.created_at::text,
      job.attempt_count
  `);

  return result.rows.map((row) => ({
    id: row.id,
    leaseToken: row.lease_token,
    parentId: row.parent_id,
    name: row.requested_name,
    createdAt: row.created_at,
    attempt: row.attempt_count,
  }));
}

export async function acknowledgeDiscordChannelCreationJob(input: {
  id: string;
  guildId: string;
  leaseToken: string;
  status: "created" | "failed";
  channelId?: string;
  channelName?: string;
  errorCode?: string;
  errorMessage?: string;
}): Promise<{ status: "created" | "pending" | "dead" }> {
  const configuredGuildId = guildId(input.guildId);

  if (input.status === "created") {
    const channelId = snowflake(input.channelId ?? "", "channelId");
    const channelName = normalizeDiscordChannelName(input.channelName ?? "");
    const result = await adminDrizzle.execute<{ status: "created" }>(sql`
      UPDATE discord_notification_channel_jobs
      SET
        status = 'created',
        created_channel_id = ${channelId},
        created_channel_name = ${channelName},
        completed_at = COALESCE(completed_at, now()),
        leased_until = NULL,
        last_error_code = NULL,
        last_error_message = NULL,
        updated_at = now()
      WHERE id = ${input.id}::uuid
        AND guild_id = ${configuredGuildId}
        AND lease_token = ${input.leaseToken}::uuid
        AND status IN ('leased', 'created')
      RETURNING status
    `);
    if (result.rows.length !== 1) throw new Error("Lease not found.");
    return { status: "created" };
  }

  const result = await adminDrizzle.execute<{
    status: "pending" | "dead";
  }>(sql`
    UPDATE discord_notification_channel_jobs
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
      completed_at = CASE
        WHEN attempt_count >= max_attempts THEN now()
        ELSE NULL
      END,
      last_error_code = ${input.errorCode?.trim().slice(0, 80) || null},
      last_error_message = ${input.errorMessage?.trim().slice(0, 500) || null},
      updated_at = now()
    WHERE id = ${input.id}::uuid
      AND guild_id = ${configuredGuildId}
      AND lease_token = ${input.leaseToken}::uuid
      AND status = 'leased'
    RETURNING status
  `);
  const row = result.rows[0];
  if (!row) throw new Error("Lease not found.");
  return { status: row.status };
}
