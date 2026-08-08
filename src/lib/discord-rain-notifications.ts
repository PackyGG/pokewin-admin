import "server-only";

import { sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { getProdReadDrizzleDb } from "@/lib/db";

export const RAIN_NOTIFICATION_THRESHOLD_USD_CENTS = 2_000;

export type DiscordRainNotificationJob = {
  id: string;
  leaseToken: string;
  rainId: string;
  poolUsdCents: number;
  participantCount: number;
  startsAt: string;
  endsAt: string;
  attempt: number;
};

type EligibleRainRow = {
  rain_id: string;
  pool_usd_cents: number;
  participant_count: number;
  starts_at: Date | string;
  ends_at: Date | string;
};

/**
 * Discover entry-open real-money rains from the production read mirror, then
 * record each rain at most once in the Admin DB. The unique rain id is the
 * durable redeploy/replica dedupe boundary.
 */
async function enqueueEligibleRains(): Promise<void> {
  const source = await getProdReadDrizzleDb().execute<EligibleRainRow>(sql`
    SELECT
      id::text AS rain_id,
      (total_pool_usd * 100)::integer AS pool_usd_cents,
      participant_count,
      starts_at,
      ends_at
    FROM rains
    WHERE status::text = 'active'
      AND currency::text = 'real'
      AND starts_at <= now()
      AND ends_at > now()
      AND total_pool_usd > 20.00::numeric
    ORDER BY starts_at, id
    LIMIT 25
  `);

  for (const rain of source.rows) {
    await adminDrizzle.execute(sql`
      INSERT INTO discord_rain_notification_jobs (
        rain_id,
        pool_usd_cents,
        participant_count,
        starts_at,
        ends_at
      ) VALUES (
        ${rain.rain_id}::uuid,
        ${rain.pool_usd_cents},
        ${rain.participant_count},
        ${rain.starts_at},
        ${rain.ends_at}
      )
      ON CONFLICT (rain_id) DO NOTHING
    `);
  }
}

export async function claimDiscordRainNotificationJobs(input: {
  workerId: string;
  limit: number;
}): Promise<DiscordRainNotificationJob[]> {
  const workerId = input.workerId.trim().slice(0, 120);
  if (!workerId) throw new Error("workerId is required.");
  const limit = Math.max(1, Math.min(10, Math.trunc(input.limit)));

  await enqueueEligibleRains();

  const result = await adminDrizzle.execute<{
    id: string;
    lease_token: string;
    rain_id: string;
    pool_usd_cents: number;
    participant_count: number;
    starts_at: Date | string;
    ends_at: Date | string;
    attempt_count: number;
  }>(sql`
    WITH exhausted AS (
      UPDATE discord_rain_notification_jobs
      SET
        status = 'dead',
        lease_token = NULL,
        lease_owner = NULL,
        leased_until = NULL,
        last_error_code = COALESCE(last_error_code, 'lease_expired'),
        last_error_message = COALESCE(
          last_error_message,
          'The final rain notification lease expired before acknowledgement.'
        ),
        updated_at = now()
      WHERE status = 'leased'
        AND leased_until < now()
        AND attempt_count >= max_attempts
      RETURNING id
    ),
    candidates AS (
      SELECT id
      FROM discord_rain_notification_jobs
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
    UPDATE discord_rain_notification_jobs AS job
    SET
      status = 'leased',
      attempt_count = job.attempt_count + 1,
      lease_token = gen_random_uuid(),
      lease_owner = ${workerId},
      leased_until = now() + interval '90 seconds',
      updated_at = now()
    FROM candidates
    WHERE job.id = candidates.id
    RETURNING
      job.id::text,
      job.lease_token::text,
      job.rain_id::text,
      job.pool_usd_cents,
      job.participant_count,
      job.starts_at,
      job.ends_at,
      job.attempt_count
  `);

  return result.rows.map((row) => ({
    id: row.id,
    leaseToken: row.lease_token,
    rainId: row.rain_id,
    poolUsdCents: row.pool_usd_cents,
    participantCount: row.participant_count,
    startsAt: new Date(row.starts_at).toISOString(),
    endsAt: new Date(row.ends_at).toISOString(),
    attempt: row.attempt_count,
  }));
}

export async function acknowledgeDiscordRainNotificationJob(input: {
  id: string;
  leaseToken: string;
  status: "delivered" | "failed";
  discordMessageId?: string;
  errorCode?: string;
  errorMessage?: string;
}): Promise<{ status: "delivered" | "pending" | "dead" }> {
  if (input.status === "delivered") {
    const result = await adminDrizzle.execute<{ status: "delivered" }>(sql`
      UPDATE discord_rain_notification_jobs
      SET
        status = 'delivered',
        discord_message_id = ${input.discordMessageId?.trim().slice(0, 30) || null},
        delivered_at = COALESCE(delivered_at, now()),
        lease_token = NULL,
        lease_owner = NULL,
        leased_until = NULL,
        last_error_code = NULL,
        last_error_message = NULL,
        updated_at = now()
      WHERE id = ${input.id}::uuid
        AND lease_token = ${input.leaseToken}::uuid
        AND status = 'leased'
      RETURNING status
    `);
    if (result.rows.length !== 1) throw new Error("Rain notification lease not found.");
    return { status: "delivered" };
  }

  const result = await adminDrizzle.execute<{ status: "pending" | "dead" }>(sql`
    UPDATE discord_rain_notification_jobs
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
  if (!row) throw new Error("Rain notification lease not found.");
  return { status: row.status };
}
