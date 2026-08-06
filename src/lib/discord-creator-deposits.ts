import "server-only";

import { sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { admin_audit_events } from "@/lib/db-schema/admin/schema";
import { getProdReadDrizzleDb } from "@/lib/db";
import {
  CREATOR_SETUP_GUILD_ID,
  requireLinkedSetupActor,
} from "@/lib/discord-creator-setups";
import { pgArrayParam } from "@/lib/drizzle-array-param";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { toNumber } from "@/lib/utils/decimal";

const SCAN_OVERLAP_MS = 2 * 60 * 1000;
const REPLICA_SETTLE_MS = 5 * 1000;
const SCAN_LEASE_SECONDS = 45;
const MAX_SCAN_ROWS = 100;

type EnabledSetup = {
  id: string;
  creator_user_id: string;
  logs_channel_id: string;
  deposit_notifications_enabled_at: string;
};

type ScanLease = {
  leaseToken: string;
  scanThroughAt: string;
};

type SourceDeposit = {
  deposit_id: string;
  user_id: string;
  username: string | null;
  amount_usd: string;
  occurred_at: string;
  creator_user_id: string;
};

type CreatorTotals = {
  creator_user_id: string;
  total_deposits_usd: string;
  deposits_30d_usd: string;
};

export type CreatorDepositSettings = {
  signupsEnabled: boolean;
  depositsEnabled: boolean;
  signupEnabledAt: string | null;
  depositEnabledAt: string | null;
  /** Compatibility fields for bot versions deployed before independent controls. */
  enabled: boolean;
  logsChannelId: string;
  enabledAt: string | null;
  updatedAt: string | null;
};

export type CreatorNotificationTarget = "signups" | "deposits";

type CreatorSettingsRow = {
  signup_notifications_enabled: boolean;
  deposit_notifications_enabled: boolean;
  logs_channel_id: string;
  signup_notifications_enabled_at: string | null;
  deposit_notifications_enabled_at: string | null;
  deposit_notifications_updated_at: string | null;
};

type CreatorSettingsUpdateRow = Omit<
  CreatorSettingsRow,
  "deposit_notifications_updated_at"
> & { deposit_notifications_updated_at: string };

export type CreatorDepositDeliveryJob = {
  id: string;
  leaseToken: string;
  channelId: string;
  depositId: string;
  depositor: {
    userId: string;
    username: string | null;
  };
  depositAmountUsd: number;
  creatorTotalDepositsUsd: number;
  creator30dDepositsUsd: number;
  occurredAt: string;
  attempt: number;
};

function roundedMoney(value: unknown): number {
  const parsed = toNumber(value);
  if (!Number.isFinite(parsed)) throw new Error("Invalid creator deposit amount.");
  return Math.round(Math.max(0, parsed) * 100) / 100;
}

function boundedWorkerId(value: string): string {
  const workerId = value.trim().slice(0, 120);
  if (!workerId) throw new Error("workerId is required.");
  return workerId;
}

export async function getCreatorDepositSettings(input: {
  guildId: string;
  categoryId: string;
  channelId: string;
  actorDiscordUserId: string;
}): Promise<CreatorDepositSettings> {
  const setup = await requireLinkedSetupActor(input);
  const result = await adminDrizzle.execute<CreatorSettingsRow>(sql`
    SELECT
      signup_notifications_enabled,
      deposit_notifications_enabled,
      logs_channel_id,
      signup_notifications_enabled_at,
      deposit_notifications_enabled_at,
      deposit_notifications_updated_at
    FROM discord_creator_setups
    WHERE id = ${setup.id}::uuid
    LIMIT 1
  `);
  const row = result.rows[0];
  if (!row) throw new Error("Creator setup disappeared while reading settings.");

  const signupsEnabled = row.signup_notifications_enabled;
  const depositsEnabled = row.deposit_notifications_enabled;
  const signupEnabledAt = row.signup_notifications_enabled_at
    ? new Date(row.signup_notifications_enabled_at).toISOString()
    : null;
  const depositEnabledAt = row.deposit_notifications_enabled_at
    ? new Date(row.deposit_notifications_enabled_at).toISOString()
    : null;
  return {
    signupsEnabled,
    depositsEnabled,
    signupEnabledAt,
    depositEnabledAt,
    enabled: signupsEnabled && depositsEnabled,
    logsChannelId: row.logs_channel_id,
    enabledAt: signupsEnabled && depositsEnabled ? depositEnabledAt : null,
    updatedAt: row.deposit_notifications_updated_at
      ? new Date(row.deposit_notifications_updated_at).toISOString()
      : null,
  };
}

export async function updateCreatorDepositSettings(input: {
  guildId: string;
  categoryId: string;
  channelId: string;
  actorDiscordUserId: string;
  interactionId: string;
  enabled: boolean;
  target?: CreatorNotificationTarget;
  apiKeyId: string;
  apiKeyPrefix: string;
}): Promise<CreatorDepositSettings> {
  const setup = await requireLinkedSetupActor(input);

  return adminDrizzle.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`creator-deposit-settings:${input.interactionId}`}, 0)
      )
    `);

    const target = input.target ?? null;
    const result = await tx.execute<CreatorSettingsUpdateRow>(sql`
      UPDATE discord_creator_setups
      SET
        signup_notifications_enabled = CASE
          WHEN ${target}::text IS NULL OR ${target} = 'signups'
            THEN ${input.enabled}
          ELSE signup_notifications_enabled
        END,
        signup_notifications_enabled_at = CASE
          WHEN ${target}::text IS NULL OR ${target} = 'signups' THEN CASE
            WHEN ${input.enabled} = false THEN NULL
            WHEN signup_notifications_enabled = false
              OR signup_notifications_enabled_at IS NULL
              THEN now()
            ELSE signup_notifications_enabled_at
          END
          ELSE signup_notifications_enabled_at
        END,
        deposit_notifications_enabled = CASE
          WHEN ${target}::text IS NULL OR ${target} = 'deposits'
            THEN ${input.enabled}
          ELSE deposit_notifications_enabled
        END,
        deposit_notifications_enabled_at = CASE
          WHEN ${target}::text IS NULL OR ${target} = 'deposits' THEN CASE
            WHEN ${input.enabled} = false THEN NULL
            WHEN deposit_notifications_enabled = false
              OR deposit_notifications_enabled_at IS NULL
              THEN now()
            ELSE deposit_notifications_enabled_at
          END
          ELSE deposit_notifications_enabled_at
        END,
        deposit_notifications_updated_at = now()
      WHERE id = ${setup.id}::uuid
        AND status = 'active'
        AND creator_user_id IS NOT NULL
      RETURNING
        signup_notifications_enabled,
        deposit_notifications_enabled,
        logs_channel_id,
        signup_notifications_enabled_at,
        deposit_notifications_enabled_at,
        deposit_notifications_updated_at
    `);
    const row = result.rows[0];
    if (!row) throw new Error("Creator setup disappeared while updating settings.");

    if (!input.enabled && (target === null || target === "deposits")) {
      await tx.execute(sql`
        UPDATE discord_creator_deposit_jobs
        SET
          status = 'dead',
          lease_token = NULL,
          lease_owner = NULL,
          leased_until = NULL,
          last_error_code = 'notifications_disabled',
          last_error_message = 'Creator disabled deposit notifications.',
          updated_at = now()
        WHERE setup_id = ${setup.id}::uuid
          AND status IN ('pending', 'leased')
      `);
    }
    if (!input.enabled && (target === null || target === "signups")) {
      await tx.execute(sql`
        UPDATE discord_creator_signup_jobs
        SET
          status = 'dead',
          lease_token = NULL,
          lease_owner = NULL,
          leased_until = NULL,
          last_error_code = 'notifications_disabled',
          last_error_message = 'Creator disabled sign-up notifications.',
          updated_at = now()
        WHERE setup_id = ${setup.id}::uuid
          AND status IN ('pending', 'leased')
      `);
    }

    await tx.insert(admin_audit_events).values({
      admin_user_id: null,
      event_type: `discord_creator_${target === "signups" ? "signup" : target ?? "activity"}_notifications_${input.enabled ? "enabled" : "disabled"}`,
      target_user_id: setup.creator_user_id,
      metadata: {
        apiKeyId: input.apiKeyId,
        apiKeyPrefix: input.apiKeyPrefix,
        setupId: setup.id,
        guildId: input.guildId,
        categoryId: input.categoryId,
        channelId: input.channelId,
        logsChannelId: row.logs_channel_id,
        actorDiscordUserId: input.actorDiscordUserId,
        interactionId: input.interactionId,
        target: target ?? "signups_and_deposits",
      },
    });

    const signupsEnabled = row.signup_notifications_enabled;
    const depositsEnabled = row.deposit_notifications_enabled;
    const signupEnabledAt = row.signup_notifications_enabled_at
      ? new Date(row.signup_notifications_enabled_at).toISOString()
      : null;
    const depositEnabledAt = row.deposit_notifications_enabled_at
      ? new Date(row.deposit_notifications_enabled_at).toISOString()
      : null;
    return {
      signupsEnabled,
      depositsEnabled,
      signupEnabledAt,
      depositEnabledAt,
      enabled: signupsEnabled && depositsEnabled,
      logsChannelId: row.logs_channel_id,
      enabledAt: signupsEnabled && depositsEnabled ? depositEnabledAt : null,
      updatedAt: new Date(row.deposit_notifications_updated_at).toISOString(),
    };
  });
}

async function acquireScanLease(workerId: string): Promise<ScanLease | null> {
  return adminDrizzle.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO discord_creator_deposit_scan_state (singleton_id)
      VALUES (1)
      ON CONFLICT (singleton_id) DO NOTHING
    `);
    const result = await tx.execute<{
      lease_token: string;
      scan_through_at: string;
    }>(sql`
      UPDATE discord_creator_deposit_scan_state
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

async function finishScanLease(
  lease: ScanLease,
  scanThroughAt: Date,
): Promise<void> {
  await adminDrizzle.execute(sql`
    UPDATE discord_creator_deposit_scan_state
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
    UPDATE discord_creator_deposit_scan_state
    SET
      lease_token = NULL,
      lease_owner = NULL,
      leased_until = NULL,
      updated_at = now()
    WHERE singleton_id = 1
      AND lease_token = ${lease.leaseToken}::uuid
  `);
}

async function enabledSetups(): Promise<EnabledSetup[]> {
  const result = await adminDrizzle.execute<EnabledSetup>(sql`
    SELECT
      id::text,
      creator_user_id,
      logs_channel_id,
      deposit_notifications_enabled_at::text
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

async function discoverSourceDeposits(
  setups: EnabledSetup[],
  scanFrom: Date,
  scanUntil: Date,
  excludedUserIds: string[],
): Promise<SourceDeposit[]> {
  const db = getProdReadDrizzleDb();
  const creatorIds = [...new Set(setups.map((setup) => setup.creator_user_id))];
  const excludedFilter =
    excludedUserIds.length > 0
      ? sql`AND deposit.user_id <> ALL(${pgArrayParam(excludedUserIds)}::text[])`
      : sql``;

  const result = await db.execute<SourceDeposit>(sql`
    WITH candidate_deposits AS (
      SELECT
        deposit.id,
        deposit.user_id,
        referred.username,
        deposit.amount::numeric AS amount_usd,
        deposit.created_at
      FROM ledger_transactions AS deposit
      JOIN "user" AS referred ON referred.id = deposit.user_id
      WHERE deposit.type = 'deposit'
        AND deposit.status = 'completed'
        AND deposit.amount::numeric > 0
        AND deposit.created_at > ${scanFrom.toISOString()}::timestamptz
        AND deposit.created_at <= ${scanUntil.toISOString()}::timestamptz
        AND referred.role::text NOT IN ('admin', 'support', 'creator')
        ${excludedFilter}
    )
    SELECT
      deposit.id::text AS deposit_id,
      deposit.user_id,
      deposit.username,
      deposit.amount_usd::text,
      deposit.created_at::text AS occurred_at,
      attribution.creator_user_id
    FROM candidate_deposits AS deposit
    JOIN LATERAL (
      SELECT usage.affiliate_user_id AS creator_user_id
      FROM affiliate_code_usages AS usage
      JOIN affiliate_codes AS owned_code
        ON owned_code.user_id = usage.affiliate_user_id
       AND UPPER(owned_code.code) = UPPER(usage.code)
      WHERE usage.referred_user_id = deposit.user_id
        AND usage.referred_user_id <> usage.affiliate_user_id
        AND usage.status::text = 'completed'
        AND usage.created_at <= deposit.created_at
        AND usage.created_at >= deposit.created_at - INTERVAL '7 days'
      ORDER BY usage.created_at DESC, usage.id DESC
      LIMIT 1
    ) AS attribution ON true
    WHERE attribution.creator_user_id = ANY(${pgArrayParam(creatorIds)}::text[])
    ORDER BY deposit.created_at, deposit.id
    LIMIT ${MAX_SCAN_ROWS + 1}
  `);
  return result.rows;
}

async function creatorDepositTotals(
  creatorIds: string[],
  excludedUserIds: string[],
): Promise<Map<string, CreatorTotals>> {
  if (creatorIds.length === 0) return new Map();
  const db = getProdReadDrizzleDb();
  const excludedFilter =
    excludedUserIds.length > 0
      ? sql`AND deposit.user_id <> ALL(${pgArrayParam(excludedUserIds)}::text[])`
      : sql``;
  const result = await db.execute<CreatorTotals>(sql`
    WITH coverage AS (
      SELECT
        usage.id,
        usage.affiliate_user_id AS creator_user_id,
        usage.referred_user_id,
        usage.created_at
      FROM affiliate_code_usages AS usage
      JOIN affiliate_codes AS owned_code
        ON owned_code.user_id = usage.affiliate_user_id
       AND UPPER(owned_code.code) = UPPER(usage.code)
      WHERE usage.affiliate_user_id = ANY(${pgArrayParam(creatorIds)}::text[])
        AND usage.referred_user_id <> usage.affiliate_user_id
        AND usage.status::text = 'completed'
    ),
    covered_deposits AS (
      SELECT DISTINCT ON (deposit.id)
        deposit.id,
        coverage.creator_user_id,
        deposit.amount::numeric AS amount_usd,
        deposit.created_at
      FROM coverage
      JOIN ledger_transactions AS deposit
        ON deposit.user_id = coverage.referred_user_id
       AND deposit.created_at >= coverage.created_at
       AND deposit.created_at <= coverage.created_at + INTERVAL '7 days'
      JOIN "user" AS referred ON referred.id = deposit.user_id
      WHERE deposit.type = 'deposit'
        AND deposit.status = 'completed'
        AND deposit.amount::numeric > 0
        AND referred.role::text NOT IN ('admin', 'support', 'creator')
        AND NOT EXISTS (
          SELECT 1
          FROM affiliate_code_usages AS newer_usage
          JOIN affiliate_codes AS newer_owned_code
            ON newer_owned_code.user_id = newer_usage.affiliate_user_id
           AND UPPER(newer_owned_code.code) = UPPER(newer_usage.code)
          WHERE newer_usage.referred_user_id = deposit.user_id
            AND newer_usage.referred_user_id <> newer_usage.affiliate_user_id
            AND newer_usage.status::text = 'completed'
            AND newer_usage.created_at <= deposit.created_at
            AND newer_usage.created_at >= deposit.created_at - INTERVAL '7 days'
            AND (
              newer_usage.created_at > coverage.created_at
              OR (
                newer_usage.created_at = coverage.created_at
                AND newer_usage.id > coverage.id
              )
            )
        )
        ${excludedFilter}
      ORDER BY deposit.id, coverage.created_at DESC, coverage.id DESC
    )
    SELECT
      creator_user_id,
      COALESCE(SUM(amount_usd), 0)::text AS total_deposits_usd,
      COALESCE(
        SUM(amount_usd) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days'),
        0
      )::text AS deposits_30d_usd
    FROM covered_deposits
    GROUP BY creator_user_id
  `);
  return new Map(result.rows.map((row) => [row.creator_user_id, row]));
}

async function enqueueDiscoveredDeposits(
  rows: SourceDeposit[],
  setups: EnabledSetup[],
  totals: Map<string, CreatorTotals>,
): Promise<number> {
  const setupByCreator = new Map(
    setups.map((setup) => [setup.creator_user_id, setup]),
  );
  const payload = rows.flatMap((row) => {
    const setup = setupByCreator.get(row.creator_user_id);
    const total = totals.get(row.creator_user_id);
    if (
      !setup ||
      !total ||
      new Date(row.occurred_at).getTime()
        < new Date(setup.deposit_notifications_enabled_at).getTime()
    ) {
      return [];
    }
    return [{
      setupId: setup.id,
      sourceDepositId: row.deposit_id,
      creatorUserId: row.creator_user_id,
      depositorUserId: row.user_id,
      depositorUsername: row.username?.trim().slice(0, 100) || null,
      depositAmountUsd: roundedMoney(row.amount_usd).toFixed(2),
      creatorTotalDepositsUsd: roundedMoney(total.total_deposits_usd).toFixed(2),
      creator30dDepositsUsd: roundedMoney(total.deposits_30d_usd).toFixed(2),
      occurredAt: new Date(row.occurred_at).toISOString(),
    }];
  });
  if (payload.length === 0) return 0;

  const result = await adminDrizzle.execute<{ inserted: number }>(sql`
    WITH source AS (
      SELECT *
      FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS row(
        "setupId" uuid,
        "sourceDepositId" uuid,
        "creatorUserId" text,
        "depositorUserId" text,
        "depositorUsername" text,
        "depositAmountUsd" numeric,
        "creatorTotalDepositsUsd" numeric,
        "creator30dDepositsUsd" numeric,
        "occurredAt" timestamptz
      )
    ),
    inserted AS (
      INSERT INTO discord_creator_deposit_jobs (
        setup_id,
        source_deposit_id,
        creator_user_id,
        depositor_user_id,
        depositor_username,
        deposit_amount_usd,
        creator_total_deposits_usd,
        creator_30d_deposits_usd,
        occurred_at
      )
      SELECT
        source."setupId",
        source."sourceDepositId",
        source."creatorUserId",
        source."depositorUserId",
        source."depositorUsername",
        source."depositAmountUsd",
        source."creatorTotalDepositsUsd",
        source."creator30dDepositsUsd",
        source."occurredAt"
      FROM source
      JOIN discord_creator_setups AS setup
        ON setup.id = source."setupId"
       AND setup.status = 'active'
       AND setup.creator_user_id = source."creatorUserId"
       AND setup.deposit_notifications_enabled = true
       AND setup.deposit_notifications_enabled_at <= source."occurredAt"
      ON CONFLICT (source_deposit_id) DO NOTHING
      RETURNING 1
    )
    SELECT count(*)::int AS inserted FROM inserted
  `);
  return result.rows[0]?.inserted ?? 0;
}

async function discoverCreatorDepositJobs(workerId: string): Promise<number> {
  const lease = await acquireScanLease(workerId);
  if (!lease) return 0;

  try {
    const scanUntil = new Date(Date.now() - REPLICA_SETTLE_MS);
    const previous = new Date(lease.scanThroughAt);
    if (scanUntil <= previous) {
      await releaseScanLease(lease);
      return 0;
    }
    const scanFrom = new Date(previous.getTime() - SCAN_OVERLAP_MS);
    const setups = await enabledSetups();
    if (setups.length === 0) {
      await finishScanLease(lease, scanUntil);
      return 0;
    }

    const excludedUserIds = await getExcludedUserIds();
    const discovered = await discoverSourceDeposits(
      setups,
      scanFrom,
      scanUntil,
      excludedUserIds,
    );
    const page = discovered.slice(0, MAX_SCAN_ROWS);
    const creatorIds = [...new Set(page.map((row) => row.creator_user_id))];
    const totals = await creatorDepositTotals(creatorIds, excludedUserIds);
    const inserted = await enqueueDiscoveredDeposits(page, setups, totals);
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

export async function claimCreatorDepositJobs(input: {
  guildId: string;
  workerId: string;
  limit: number;
}): Promise<CreatorDepositDeliveryJob[]> {
  if (input.guildId !== CREATOR_SETUP_GUILD_ID) {
    throw new Error("Creator deposit jobs are pinned to the creator guild.");
  }
  const workerId = boundedWorkerId(input.workerId);
  const limit = Math.max(1, Math.min(10, Math.trunc(input.limit)));

  await discoverCreatorDepositJobs(workerId);

  const result = await adminDrizzle.execute<{
    id: string;
    lease_token: string;
    logs_channel_id: string;
    source_deposit_id: string;
    depositor_user_id: string;
    depositor_username: string | null;
    deposit_amount_usd: string;
    creator_total_deposits_usd: string;
    creator_30d_deposits_usd: string;
    occurred_at: string;
    attempt_count: number;
  }>(sql`
    WITH disabled AS (
      UPDATE discord_creator_deposit_jobs AS job
      SET
        status = 'dead',
        lease_token = NULL,
        lease_owner = NULL,
        leased_until = NULL,
        last_error_code = 'notifications_disabled',
        last_error_message = 'Creator deposit notifications are disabled.',
        updated_at = now()
      FROM discord_creator_setups AS setup
      WHERE job.setup_id = setup.id
        AND job.status IN ('pending', 'leased')
        AND (
          setup.status <> 'active'
          OR setup.deposit_notifications_enabled = false
          OR setup.logs_channel_id IS NULL
        )
      RETURNING job.id
    ),
    exhausted AS (
      UPDATE discord_creator_deposit_jobs
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
      WHERE status = 'leased'
        AND leased_until < now()
        AND attempt_count >= max_attempts
      RETURNING id
    ),
    candidates AS (
      SELECT job.id
      FROM discord_creator_deposit_jobs AS job
      JOIN discord_creator_setups AS setup ON setup.id = job.setup_id
      WHERE setup.guild_id = ${input.guildId}
        AND setup.status = 'active'
        AND setup.deposit_notifications_enabled = true
        AND setup.logs_channel_id IS NOT NULL
        AND job.available_at <= now()
        AND job.attempt_count < job.max_attempts
        AND (
          job.status = 'pending'
          OR (job.status = 'leased' AND job.leased_until < now())
        )
      ORDER BY job.available_at, job.created_at, job.id
      FOR UPDATE OF job SKIP LOCKED
      LIMIT ${limit}
    )
    UPDATE discord_creator_deposit_jobs AS job
    SET
      status = 'leased',
      attempt_count = job.attempt_count + 1,
      lease_token = gen_random_uuid(),
      lease_owner = ${workerId},
      leased_until = now() + interval '60 seconds',
      updated_at = now()
    FROM candidates, discord_creator_setups AS setup
    WHERE job.id = candidates.id
      AND setup.id = job.setup_id
    RETURNING
      job.id::text,
      job.lease_token::text,
      setup.logs_channel_id,
      job.source_deposit_id::text,
      job.depositor_user_id,
      job.depositor_username,
      job.deposit_amount_usd::text,
      job.creator_total_deposits_usd::text,
      job.creator_30d_deposits_usd::text,
      job.occurred_at::text,
      job.attempt_count
  `);

  return result.rows.map((row) => ({
    id: row.id,
    leaseToken: row.lease_token,
    channelId: row.logs_channel_id,
    depositId: row.source_deposit_id,
    depositor: {
      userId: row.depositor_user_id,
      username: row.depositor_username,
    },
    depositAmountUsd: roundedMoney(row.deposit_amount_usd),
    creatorTotalDepositsUsd: roundedMoney(row.creator_total_deposits_usd),
    creator30dDepositsUsd: roundedMoney(row.creator_30d_deposits_usd),
    occurredAt: new Date(row.occurred_at).toISOString(),
    attempt: row.attempt_count,
  }));
}

export async function acknowledgeCreatorDepositJob(input: {
  id: string;
  leaseToken: string;
  guildId: string;
  status: "delivered" | "failed";
  discordMessageId?: string;
  errorCode?: string;
  errorMessage?: string;
}): Promise<{ status: "delivered" | "pending" | "dead" }> {
  if (input.guildId !== CREATOR_SETUP_GUILD_ID) {
    throw new Error("Creator deposit jobs are pinned to the creator guild.");
  }
  if (input.status === "delivered") {
    const result = await adminDrizzle.execute<{ status: "delivered" }>(sql`
      UPDATE discord_creator_deposit_jobs AS job
      SET
        status = 'delivered',
        discord_message_id = ${input.discordMessageId?.trim().slice(0, 30) || null},
        delivered_at = COALESCE(delivered_at, now()),
        leased_until = NULL,
        last_error_code = NULL,
        last_error_message = NULL,
        updated_at = now()
      FROM discord_creator_setups AS setup
      WHERE job.id = ${input.id}::uuid
        AND job.setup_id = setup.id
        AND setup.guild_id = ${input.guildId}
        AND job.lease_token = ${input.leaseToken}::uuid
        AND job.status IN ('leased', 'delivered')
      RETURNING job.status
    `);
    if (result.rows.length !== 1) throw new Error("Creator deposit lease not found.");
    return { status: "delivered" };
  }

  const result = await adminDrizzle.execute<{ status: "pending" | "dead" }>(sql`
    UPDATE discord_creator_deposit_jobs AS job
    SET
      status = CASE
        WHEN job.attempt_count >= job.max_attempts
          OR setup.deposit_notifications_enabled = false
          THEN 'dead'
        ELSE 'pending'
      END,
      available_at = now() + (
        LEAST(300, power(2, LEAST(job.attempt_count, 8))::int) * interval '1 second'
      ),
      lease_token = NULL,
      lease_owner = NULL,
      leased_until = NULL,
      last_error_code = ${input.errorCode?.trim().slice(0, 80) || null},
      last_error_message = ${input.errorMessage?.trim().slice(0, 500) || null},
      updated_at = now()
    FROM discord_creator_setups AS setup
    WHERE job.id = ${input.id}::uuid
      AND job.setup_id = setup.id
      AND setup.guild_id = ${input.guildId}
      AND job.lease_token = ${input.leaseToken}::uuid
      AND job.status = 'leased'
    RETURNING job.status
  `);
  const row = result.rows[0];
  if (!row) throw new Error("Creator deposit lease not found.");
  return { status: row.status };
}
