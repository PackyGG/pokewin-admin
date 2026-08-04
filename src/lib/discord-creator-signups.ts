import "server-only";

import { sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { getProdReadDrizzleDb } from "@/lib/db";
import { CREATOR_SETUP_GUILD_ID } from "@/lib/discord-creator-setups";
import { pgArrayParam } from "@/lib/drizzle-array-param";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";

const SCAN_OVERLAP_MS = 2 * 60 * 1000;
const REPLICA_SETTLE_MS = 5 * 1000;
const SCAN_LEASE_SECONDS = 45;
const MAX_SCAN_ROWS = 100;

type EnabledSetup = {
  id: string;
  creator_user_id: string;
  deposit_notifications_enabled_at: string;
};

type ScanLease = { leaseToken: string; scanThroughAt: string };

type SourceSignup = {
  signup_id: string;
  creator_user_id: string;
  referred_user_id: string;
  referred_username: string | null;
  affiliate_code: string;
  occurred_at: string;
};

export type CreatorSignupDeliveryJob = {
  id: string;
  leaseToken: string;
  channelId: string;
  signupId: string;
  referredUser: { userId: string; username: string | null };
  affiliateCode: string;
  occurredAt: string;
  attempt: number;
};

function boundedWorkerId(value: string): string {
  const workerId = value.trim().slice(0, 120);
  if (!workerId) throw new Error("workerId is required.");
  return workerId;
}

async function acquireScanLease(workerId: string): Promise<ScanLease | null> {
  return adminDrizzle.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO discord_creator_signup_scan_state (singleton_id)
      VALUES (1)
      ON CONFLICT (singleton_id) DO NOTHING
    `);
    const result = await tx.execute<{
      lease_token: string;
      scan_through_at: string;
    }>(sql`
      UPDATE discord_creator_signup_scan_state
      SET
        lease_token = gen_random_uuid(),
        lease_owner = ${workerId},
        leased_until = now() + ${SCAN_LEASE_SECONDS} * interval '1 second',
        updated_at = now()
      WHERE singleton_id = 1
        AND (leased_until IS NULL OR leased_until < now())
      RETURNING lease_token::text, scan_through_at::text
    `);
    const row = result.rows[0];
    return row
      ? { leaseToken: row.lease_token, scanThroughAt: row.scan_through_at }
      : null;
  });
}

async function finishScanLease(lease: ScanLease, scanThroughAt: Date): Promise<void> {
  await adminDrizzle.execute(sql`
    UPDATE discord_creator_signup_scan_state
    SET
      scan_through_at = GREATEST(scan_through_at, ${scanThroughAt.toISOString()}::timestamptz),
      lease_token = NULL,
      lease_owner = NULL,
      leased_until = NULL,
      updated_at = now()
    WHERE singleton_id = 1
      AND lease_token = ${lease.leaseToken}::uuid
  `);
}

async function releaseScanLease(lease: ScanLease): Promise<void> {
  await adminDrizzle.execute(sql`
    UPDATE discord_creator_signup_scan_state
    SET lease_token = NULL, lease_owner = NULL, leased_until = NULL, updated_at = now()
    WHERE singleton_id = 1
      AND lease_token = ${lease.leaseToken}::uuid
  `);
}

async function enabledSetups(): Promise<EnabledSetup[]> {
  const result = await adminDrizzle.execute<EnabledSetup>(sql`
    SELECT id::text, creator_user_id, deposit_notifications_enabled_at::text
    FROM discord_creator_setups
    WHERE guild_id = ${CREATOR_SETUP_GUILD_ID}
      AND status = 'active'
      AND creator_user_id IS NOT NULL
      AND logs_channel_id IS NOT NULL
      AND deposit_notifications_enabled = true
      AND deposit_notifications_enabled_at IS NOT NULL
    ORDER BY id
  `);
  return result.rows;
}

async function discoverSourceSignups(
  setups: EnabledSetup[],
  scanFrom: Date,
  scanUntil: Date,
  excludedUserIds: string[],
): Promise<SourceSignup[]> {
  const creatorIds = [...new Set(setups.map((setup) => setup.creator_user_id))];
  const excludedFilter = excludedUserIds.length > 0
    ? sql`AND usage.referred_user_id <> ALL(${pgArrayParam(excludedUserIds)}::text[])`
    : sql``;
  const result = await getProdReadDrizzleDb().execute<SourceSignup>(sql`
    SELECT
      usage.id::text AS signup_id,
      usage.affiliate_user_id AS creator_user_id,
      usage.referred_user_id,
      referred.username AS referred_username,
      usage.code AS affiliate_code,
      usage.created_at::text AS occurred_at
    FROM affiliate_code_usages AS usage
    JOIN affiliate_codes AS owned_code
      ON owned_code.user_id = usage.affiliate_user_id
     AND UPPER(owned_code.code) = UPPER(usage.code)
    JOIN "user" AS referred ON referred.id = usage.referred_user_id
    WHERE usage.usage_type::text = 'signup'
      AND usage.status::text = 'completed'
      AND usage.affiliate_user_id = ANY(${pgArrayParam(creatorIds)}::text[])
      AND usage.referred_user_id <> usage.affiliate_user_id
      AND usage.created_at > ${scanFrom.toISOString()}::timestamptz
      AND usage.created_at <= ${scanUntil.toISOString()}::timestamptz
      AND referred.role::text NOT IN ('admin', 'support', 'creator')
      ${excludedFilter}
    ORDER BY usage.created_at, usage.id
    LIMIT ${MAX_SCAN_ROWS + 1}
  `);
  return result.rows;
}

async function enqueueSignups(rows: SourceSignup[], setups: EnabledSetup[]): Promise<number> {
  const setupByCreator = new Map(setups.map((setup) => [setup.creator_user_id, setup]));
  const payload = rows.flatMap((row) => {
    const setup = setupByCreator.get(row.creator_user_id);
    if (
      !setup
      || new Date(row.occurred_at).getTime()
        < new Date(setup.deposit_notifications_enabled_at).getTime()
    ) return [];
    return [{
      setupId: setup.id,
      sourceSignupId: row.signup_id,
      creatorUserId: row.creator_user_id,
      referredUserId: row.referred_user_id,
      referredUsername: row.referred_username?.trim().slice(0, 100) || null,
      affiliateCode: row.affiliate_code.trim().slice(0, 100),
      occurredAt: new Date(row.occurred_at).toISOString(),
    }];
  });
  if (payload.length === 0) return 0;

  const result = await adminDrizzle.execute<{ inserted: number }>(sql`
    WITH source AS (
      SELECT *
      FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS row(
        "setupId" uuid,
        "sourceSignupId" uuid,
        "creatorUserId" text,
        "referredUserId" text,
        "referredUsername" text,
        "affiliateCode" text,
        "occurredAt" timestamptz
      )
    ), inserted AS (
      INSERT INTO discord_creator_signup_jobs (
        setup_id, source_signup_id, creator_user_id, referred_user_id,
        referred_username, affiliate_code, occurred_at
      )
      SELECT
        source."setupId", source."sourceSignupId", source."creatorUserId",
        source."referredUserId", source."referredUsername",
        source."affiliateCode", source."occurredAt"
      FROM source
      JOIN discord_creator_setups AS setup
        ON setup.id = source."setupId"
       AND setup.status = 'active'
       AND setup.creator_user_id = source."creatorUserId"
       AND setup.deposit_notifications_enabled = true
       AND setup.deposit_notifications_enabled_at <= source."occurredAt"
      ON CONFLICT (source_signup_id) DO NOTHING
      RETURNING 1
    )
    SELECT count(*)::int AS inserted FROM inserted
  `);
  return result.rows[0]?.inserted ?? 0;
}

async function discoverCreatorSignupJobs(workerId: string): Promise<number> {
  const lease = await acquireScanLease(workerId);
  if (!lease) return 0;
  try {
    const scanUntil = new Date(Date.now() - REPLICA_SETTLE_MS);
    const previous = new Date(lease.scanThroughAt);
    if (scanUntil <= previous) {
      await releaseScanLease(lease);
      return 0;
    }
    const setups = await enabledSetups();
    if (setups.length === 0) {
      await finishScanLease(lease, scanUntil);
      return 0;
    }
    const discovered = await discoverSourceSignups(
      setups,
      new Date(previous.getTime() - SCAN_OVERLAP_MS),
      scanUntil,
      await getExcludedUserIds(),
    );
    const page = discovered.slice(0, MAX_SCAN_ROWS);
    const inserted = await enqueueSignups(page, setups);
    const nextCursor = discovered.length > MAX_SCAN_ROWS && page.length > 0
      ? new Date(page[page.length - 1]!.occurred_at)
      : scanUntil;
    await finishScanLease(lease, nextCursor);
    return inserted;
  } catch (error) {
    await releaseScanLease(lease).catch(() => undefined);
    throw error;
  }
}

export async function claimCreatorSignupJobs(input: {
  guildId: string;
  workerId: string;
  limit: number;
}): Promise<CreatorSignupDeliveryJob[]> {
  if (input.guildId !== CREATOR_SETUP_GUILD_ID) {
    throw new Error("Creator signup jobs are pinned to the creator guild.");
  }
  const workerId = boundedWorkerId(input.workerId);
  const limit = Math.max(1, Math.min(10, Math.trunc(input.limit)));
  await discoverCreatorSignupJobs(workerId);

  const result = await adminDrizzle.execute<{
    id: string; lease_token: string; logs_channel_id: string;
    source_signup_id: string; referred_user_id: string;
    referred_username: string | null; affiliate_code: string;
    occurred_at: string; attempt_count: number;
  }>(sql`
    WITH disabled AS (
      UPDATE discord_creator_signup_jobs AS job
      SET status = 'dead', lease_token = NULL, lease_owner = NULL, leased_until = NULL,
          last_error_code = 'notifications_disabled',
          last_error_message = 'Creator activity notifications are disabled.', updated_at = now()
      FROM discord_creator_setups AS setup
      WHERE job.setup_id = setup.id
        AND job.status IN ('pending', 'leased')
        AND (setup.status <> 'active' OR setup.deposit_notifications_enabled = false OR setup.logs_channel_id IS NULL)
      RETURNING job.id
    ), exhausted AS (
      UPDATE discord_creator_signup_jobs
      SET status = 'dead', lease_token = NULL, lease_owner = NULL, leased_until = NULL,
          last_error_code = COALESCE(last_error_code, 'lease_expired'),
          last_error_message = COALESCE(last_error_message, 'The final delivery lease expired before acknowledgement.'),
          updated_at = now()
      WHERE status = 'leased' AND leased_until < now() AND attempt_count >= max_attempts
      RETURNING id
    ), candidates AS (
      SELECT job.id
      FROM discord_creator_signup_jobs AS job
      JOIN discord_creator_setups AS setup ON setup.id = job.setup_id
      WHERE setup.guild_id = ${input.guildId}
        AND setup.status = 'active'
        AND setup.deposit_notifications_enabled = true
        AND setup.logs_channel_id IS NOT NULL
        AND job.available_at <= now()
        AND job.attempt_count < job.max_attempts
        AND (job.status = 'pending' OR (job.status = 'leased' AND job.leased_until < now()))
      ORDER BY job.available_at, job.created_at, job.id
      FOR UPDATE OF job SKIP LOCKED
      LIMIT ${limit}
    )
    UPDATE discord_creator_signup_jobs AS job
    SET status = 'leased', attempt_count = job.attempt_count + 1,
        lease_token = gen_random_uuid(), lease_owner = ${workerId},
        leased_until = now() + interval '60 seconds', updated_at = now()
    FROM candidates, discord_creator_setups AS setup
    WHERE job.id = candidates.id AND setup.id = job.setup_id
    RETURNING job.id::text, job.lease_token::text, setup.logs_channel_id,
      job.source_signup_id::text, job.referred_user_id, job.referred_username,
      job.affiliate_code, job.occurred_at::text, job.attempt_count
  `);
  return result.rows.map((row) => ({
    id: row.id,
    leaseToken: row.lease_token,
    channelId: row.logs_channel_id,
    signupId: row.source_signup_id,
    referredUser: { userId: row.referred_user_id, username: row.referred_username },
    affiliateCode: row.affiliate_code,
    occurredAt: new Date(row.occurred_at).toISOString(),
    attempt: row.attempt_count,
  }));
}

export async function acknowledgeCreatorSignupJob(input: {
  id: string;
  leaseToken: string;
  guildId: string;
  status: "delivered" | "failed";
  discordMessageId?: string;
  errorCode?: string;
  errorMessage?: string;
}): Promise<{ status: "delivered" | "pending" | "dead" }> {
  if (input.guildId !== CREATOR_SETUP_GUILD_ID) {
    throw new Error("Creator signup jobs are pinned to the creator guild.");
  }
  if (input.status === "delivered") {
    const result = await adminDrizzle.execute<{ status: "delivered" }>(sql`
      UPDATE discord_creator_signup_jobs AS job
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
    if (result.rows.length !== 1) throw new Error("Creator signup lease not found.");
    return { status: "delivered" };
  }
  const result = await adminDrizzle.execute<{ status: "pending" | "dead" }>(sql`
    UPDATE discord_creator_signup_jobs AS job
    SET status = CASE
          WHEN job.attempt_count >= job.max_attempts OR setup.deposit_notifications_enabled = false
            THEN 'dead' ELSE 'pending' END,
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
  if (!row) throw new Error("Creator signup lease not found.");
  return { status: row.status };
}
