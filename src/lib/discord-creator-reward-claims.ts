import "server-only";

import { sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { getProdReadDrizzleDb } from "@/lib/db";
import { CREATOR_SETUP_GUILD_ID } from "@/lib/discord-creator-setups";

/**
 * Posts an APPROVED creator VIP reward claim (FTD lossback, wager milestone,
 * ...) into the creator's Discord logs channel — the same channel that
 * already carries sign-up and deposit activity for that creator's referred
 * users.
 *
 * Unlike sign-ups/deposits this has no discovery scan: approval happens
 * inside this app (`approveCreatorRewardClaim`), so the job is inserted
 * directly at that moment. Never call this for a merely REQUESTED/pending
 * claim — only once the claim has actually been approved and paid.
 */

export type CreatorRewardClaimDeliveryJob = {
  id: string;
  leaseToken: string;
  channelId: string;
  claimId: string;
  referredUser: { userId: string; username: string | null };
  leg: string;
  programName: string;
  amountUsd: number;
  units: number;
  occurredAt: string;
  attempt: number;
};

function boundedWorkerId(value: string): string {
  const workerId = value.trim().slice(0, 120);
  if (!workerId) throw new Error("workerId is required.");
  return workerId;
}

/**
 * Insert the delivery job for an approved claim. Idempotent on
 * `source_claim_id` — safe to call again on a retried approval.
 *
 * Silently does nothing if the creator has no active, linked Discord setup
 * with a logs channel — that is a valid state (a creator who never ran
 * `/setup`), not an error.
 */
export async function enqueueCreatorRewardClaimNotification(input: {
  claimId: string;
  creatorUserId: string;
  referredUserId: string;
  leg: string;
  programName: string;
  amountUsd: number;
  units: number;
  occurredAt: string;
}): Promise<void> {
  const setupResult = await adminDrizzle.execute<{ id: string }>(sql`
    SELECT id::text
    FROM discord_creator_setups
    WHERE guild_id = ${CREATOR_SETUP_GUILD_ID}
      AND status = 'active'
      AND creator_user_id = ${input.creatorUserId}
      AND logs_channel_id IS NOT NULL
    LIMIT 1
  `);
  const setup = setupResult.rows[0];
  if (!setup) return;

  const userResult = await getProdReadDrizzleDb().execute<{
    username: string | null;
  }>(sql`
    SELECT username FROM "user" WHERE id = ${input.referredUserId} LIMIT 1
  `);
  const username = userResult.rows[0]?.username?.trim().slice(0, 100) || null;

  await adminDrizzle.execute(sql`
    INSERT INTO discord_creator_reward_claim_jobs (
      setup_id, source_claim_id, creator_user_id, referred_user_id,
      referred_username, leg, program_name, amount_usd, units, occurred_at
    )
    VALUES (
      ${setup.id}::uuid, ${input.claimId}::uuid, ${input.creatorUserId},
      ${input.referredUserId}, ${username}, ${input.leg},
      ${input.programName.slice(0, 200)}, ${input.amountUsd}, ${input.units},
      ${input.occurredAt}::timestamptz
    )
    ON CONFLICT (source_claim_id) DO NOTHING
  `);
}

export async function claimCreatorRewardClaimJobs(input: {
  guildId: string;
  workerId: string;
  limit: number;
}): Promise<CreatorRewardClaimDeliveryJob[]> {
  if (input.guildId !== CREATOR_SETUP_GUILD_ID) {
    throw new Error("Creator reward claim jobs are pinned to the creator guild.");
  }
  const workerId = boundedWorkerId(input.workerId);
  const limit = Math.max(1, Math.min(10, Math.trunc(input.limit)));

  const result = await adminDrizzle.execute<{
    id: string;
    lease_token: string;
    logs_channel_id: string;
    source_claim_id: string;
    referred_user_id: string;
    referred_username: string | null;
    leg: string;
    program_name: string;
    amount_usd: string;
    units: number;
    occurred_at: string;
    attempt_count: number;
  }>(sql`
    WITH disabled AS (
      UPDATE discord_creator_reward_claim_jobs AS job
      SET status = 'dead', lease_token = NULL, lease_owner = NULL, leased_until = NULL,
          last_error_code = 'setup_inactive',
          last_error_message = 'Creator Discord setup is no longer active.', updated_at = now()
      FROM discord_creator_setups AS setup
      WHERE job.setup_id = setup.id
        AND job.status IN ('pending', 'leased')
        AND (setup.status <> 'active' OR setup.logs_channel_id IS NULL)
      RETURNING job.id
    ), exhausted AS (
      UPDATE discord_creator_reward_claim_jobs
      SET status = 'dead', lease_token = NULL, lease_owner = NULL, leased_until = NULL,
          last_error_code = COALESCE(last_error_code, 'lease_expired'),
          last_error_message = COALESCE(last_error_message, 'The final delivery lease expired before acknowledgement.'),
          updated_at = now()
      WHERE status = 'leased' AND leased_until < now() AND attempt_count >= max_attempts
      RETURNING id
    ), candidates AS (
      SELECT job.id
      FROM discord_creator_reward_claim_jobs AS job
      JOIN discord_creator_setups AS setup ON setup.id = job.setup_id
      WHERE setup.guild_id = ${input.guildId}
        AND setup.status = 'active'
        AND setup.logs_channel_id IS NOT NULL
        AND job.available_at <= now()
        AND job.attempt_count < job.max_attempts
        AND (job.status = 'pending' OR (job.status = 'leased' AND job.leased_until < now()))
      ORDER BY job.available_at, job.created_at, job.id
      FOR UPDATE OF job SKIP LOCKED
      LIMIT ${limit}
    )
    UPDATE discord_creator_reward_claim_jobs AS job
    SET status = 'leased', attempt_count = job.attempt_count + 1,
        lease_token = gen_random_uuid(), lease_owner = ${workerId},
        leased_until = now() + interval '60 seconds', updated_at = now()
    FROM candidates, discord_creator_setups AS setup
    WHERE job.id = candidates.id AND setup.id = job.setup_id
    RETURNING job.id::text, job.lease_token::text, setup.logs_channel_id,
      job.source_claim_id::text, job.referred_user_id, job.referred_username,
      job.leg, job.program_name, job.amount_usd::text, job.units,
      job.occurred_at::text, job.attempt_count
  `);
  return result.rows.map((row) => ({
    id: row.id,
    leaseToken: row.lease_token,
    channelId: row.logs_channel_id,
    claimId: row.source_claim_id,
    referredUser: { userId: row.referred_user_id, username: row.referred_username },
    leg: row.leg,
    programName: row.program_name,
    amountUsd: Number(row.amount_usd),
    units: row.units,
    occurredAt: new Date(row.occurred_at).toISOString(),
    attempt: row.attempt_count,
  }));
}

export async function acknowledgeCreatorRewardClaimJob(input: {
  id: string;
  leaseToken: string;
  guildId: string;
  status: "delivered" | "failed";
  discordMessageId?: string;
  errorCode?: string;
  errorMessage?: string;
}): Promise<{ status: "delivered" | "pending" | "dead" }> {
  if (input.guildId !== CREATOR_SETUP_GUILD_ID) {
    throw new Error("Creator reward claim jobs are pinned to the creator guild.");
  }
  if (input.status === "delivered") {
    const result = await adminDrizzle.execute<{ status: "delivered" }>(sql`
      UPDATE discord_creator_reward_claim_jobs AS job
      SET status = 'delivered',
          discord_message_id = ${input.discordMessageId?.trim().slice(0, 30) || null},
          delivered_at = COALESCE(delivered_at, now()), leased_until = NULL,
          last_error_code = NULL, last_error_message = NULL, updated_at = now()
      FROM discord_creator_setups AS setup
      WHERE job.id = ${input.id}::uuid AND job.setup_id = setup.id
        AND setup.guild_id = ${input.guildId}
        AND job.lease_token = ${input.leaseToken}::uuid
        AND job.status IN ('leased', 'delivered')
      RETURNING job.status
    `);
    if (result.rows.length !== 1) {
      throw new Error("Creator reward claim lease not found.");
    }
    return { status: "delivered" };
  }
  const result = await adminDrizzle.execute<{ status: "pending" | "dead" }>(sql`
    UPDATE discord_creator_reward_claim_jobs AS job
    SET status = CASE
          WHEN job.attempt_count >= job.max_attempts THEN 'dead' ELSE 'pending' END,
        available_at = now() + (LEAST(300, power(2, LEAST(job.attempt_count, 8))::int) * interval '1 second'),
        lease_token = NULL, lease_owner = NULL, leased_until = NULL,
        last_error_code = ${input.errorCode?.trim().slice(0, 80) || null},
        last_error_message = ${input.errorMessage?.trim().slice(0, 500) || null},
        updated_at = now()
    FROM discord_creator_setups AS setup
    WHERE job.id = ${input.id}::uuid AND job.setup_id = setup.id
      AND setup.guild_id = ${input.guildId}
      AND job.lease_token = ${input.leaseToken}::uuid AND job.status = 'leased'
    RETURNING job.status
  `);
  const row = result.rows[0];
  if (!row) throw new Error("Creator reward claim lease not found.");
  return { status: row.status };
}
