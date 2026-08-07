import "server-only";

import { sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";

export const CREATOR_REMINDER_GUILD_ID = "1402743122789929022";
export const VIP_REMINDER_GUILD_ID = "1505650386894327919";
export const REMINDER_USER_IDS = [
  "660132586630414338",
  "934854938641715240",
  "188051599099297802",
] as const;

const REMINDER_CHANNELS = new Map([
  [CREATOR_REMINDER_GUILD_ID, "1534285553661513768"],
  [VIP_REMINDER_GUILD_ID, "1534285599484149760"],
]);

export type DiscordReminderJob = {
  id: string;
  leaseToken: string;
  guildId: string;
  sourceChannelId: string;
  targetChannelId: string;
  userId: string;
  dueAt: string;
  attempt: number;
};

export function reminderChannelForGuild(guildId: string): string | null {
  return REMINDER_CHANNELS.get(guildId) ?? null;
}

export function isReminderUserAllowed(userId: string): boolean {
  return REMINDER_USER_IDS.includes(userId as typeof REMINDER_USER_IDS[number]);
}

export async function createDiscordReminder(input: {
  interactionId: string;
  guildId: string;
  sourceChannelId: string;
  userId: string;
}): Promise<{ id: string; dueAt: string; targetChannelId: string }> {
  const targetChannelId = reminderChannelForGuild(input.guildId);
  if (!targetChannelId) throw new Error("Reminder guild is not allowed.");
  if (!isReminderUserAllowed(input.userId)) {
    throw new Error("Reminder user is not allowed.");
  }

  const result = await adminDrizzle.execute<{
    id: string;
    due_at: string;
    target_channel_id: string;
  }>(sql`
    INSERT INTO discord_reminder_jobs (
      interaction_id,
      guild_id,
      source_channel_id,
      target_channel_id,
      user_id,
      due_at,
      available_at
    ) VALUES (
      ${input.interactionId},
      ${input.guildId},
      ${input.sourceChannelId},
      ${targetChannelId},
      ${input.userId},
      now() + interval '1 hour',
      now() + interval '1 hour'
    )
    ON CONFLICT (interaction_id) DO UPDATE
    SET interaction_id = EXCLUDED.interaction_id
    WHERE discord_reminder_jobs.guild_id = EXCLUDED.guild_id
      AND discord_reminder_jobs.source_channel_id = EXCLUDED.source_channel_id
      AND discord_reminder_jobs.target_channel_id = EXCLUDED.target_channel_id
      AND discord_reminder_jobs.user_id = EXCLUDED.user_id
    RETURNING id::text, due_at::text, target_channel_id
  `);
  const row = result.rows[0];
  if (!row) throw new Error("Reminder interaction conflicts with an existing request.");
  return {
    id: row.id,
    dueAt: new Date(row.due_at).toISOString(),
    targetChannelId: row.target_channel_id,
  };
}

export async function claimDiscordReminderJobs(input: {
  workerId: string;
  limit: number;
}): Promise<DiscordReminderJob[]> {
  const workerId = input.workerId.trim().slice(0, 120);
  if (!workerId) throw new Error("workerId is required.");
  const limit = Math.max(1, Math.min(10, Math.trunc(input.limit)));

  const result = await adminDrizzle.execute<{
    id: string;
    lease_token: string;
    guild_id: string;
    source_channel_id: string;
    target_channel_id: string;
    user_id: string;
    due_at: string;
    attempt_count: number;
  }>(sql`
    WITH exhausted AS (
      UPDATE discord_reminder_jobs
      SET
        status = 'dead',
        lease_token = NULL,
        lease_owner = NULL,
        leased_until = NULL,
        last_error_code = COALESCE(last_error_code, 'lease_expired'),
        last_error_message = COALESCE(
          last_error_message,
          'The final reminder lease expired before acknowledgement.'
        ),
        updated_at = now()
      WHERE status = 'leased'
        AND leased_until < now()
        AND attempt_count >= max_attempts
      RETURNING id
    ),
    candidates AS (
      SELECT id
      FROM discord_reminder_jobs
      WHERE available_at <= now()
        AND attempt_count < max_attempts
        AND (
          status = 'pending'
          OR (status = 'leased' AND leased_until < now())
        )
      ORDER BY available_at, created_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    UPDATE discord_reminder_jobs AS job
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
      job.guild_id,
      job.source_channel_id,
      job.target_channel_id,
      job.user_id,
      job.due_at::text,
      job.attempt_count
  `);

  return result.rows.map((row) => ({
    id: row.id,
    leaseToken: row.lease_token,
    guildId: row.guild_id,
    sourceChannelId: row.source_channel_id,
    targetChannelId: row.target_channel_id,
    userId: row.user_id,
    dueAt: new Date(row.due_at).toISOString(),
    attempt: row.attempt_count,
  }));
}

export async function acknowledgeDiscordReminderJob(input: {
  id: string;
  leaseToken: string;
  status: "delivered" | "failed";
  discordMessageId?: string;
  errorCode?: string;
  errorMessage?: string;
}): Promise<{ status: "delivered" | "pending" | "dead" }> {
  if (input.status === "delivered") {
    const result = await adminDrizzle.execute<{ status: "delivered" }>(sql`
      UPDATE discord_reminder_jobs
      SET
        status = 'delivered',
        discord_message_id = ${input.discordMessageId?.trim().slice(0, 30) || null},
        delivered_at = COALESCE(delivered_at, now()),
        leased_until = NULL,
        last_error_code = NULL,
        last_error_message = NULL,
        updated_at = now()
      WHERE id = ${input.id}::uuid
        AND lease_token = ${input.leaseToken}::uuid
        AND status IN ('leased', 'delivered')
      RETURNING status
    `);
    if (result.rows.length !== 1) throw new Error("Reminder lease not found.");
    return { status: "delivered" };
  }

  const result = await adminDrizzle.execute<{ status: "pending" | "dead" }>(sql`
    UPDATE discord_reminder_jobs
    SET
      status = CASE WHEN attempt_count >= max_attempts THEN 'dead' ELSE 'pending' END,
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
      AND lease_token = ${input.leaseToken}::uuid
      AND status = 'leased'
    RETURNING status
  `);
  const row = result.rows[0];
  if (!row) throw new Error("Reminder lease not found.");
  return { status: row.status };
}
