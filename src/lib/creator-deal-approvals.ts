import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { adminDrizzle } from "@/lib/admin-db";
import { creatorsApi, type CreateDealInput, type CreatorDealResponse } from "@/lib/backend-api";
import {
  admin_audit_events,
  creator_deal_approval_events,
  creator_deal_approval_requests,
  creator_reward_program_windows,
  creator_reward_programs,
  discord_creator_setups,
} from "@/lib/db-schema/admin/schema";
import { account, affiliate_codes, user } from "@/lib/db-schema/main/schema";
import { getProdReadDrizzleDb } from "@/lib/db";
import { sanitizeProgramName } from "@/lib/creator-vip/sanitize";
import { rewardProgramsCanContinue } from "@/lib/creator-vip/continuity";
import { getPublishedCreatorAgreementTerms } from "@/lib/creator-agreement-terms";
import { isPostgresError } from "@/lib/postgres-errors";

const DiscordId = z.string().regex(/^\d{17,20}$/);
const UserId = z.string().trim().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/);
const Uuid = z.string().uuid();
const Cents = (max: number) => z.number().finite().min(0).max(max).refine(
  (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8,
  "Amounts cannot be finer than one cent.",
);
const PositiveCents = (max: number) => Cents(max).refine((value) => value > 0);

const DealPayloadSchema = z.object({
  week_start_utc: z.string().datetime({ offset: true }),
  week_end_utc: z.string().datetime({ offset: true }),
  fills_allowed: z.number().int().positive().max(10_000),
  per_fill_amount_usd: PositiveCents(1_000_000),
  conversion_rate_bps: z.number().int().min(0).max(10_000),
  total_withdraw_cap_usd: Cents(10_000_000).nullable(),
  cooldown_minutes: z.number().int().min(0).max(525_600),
  max_tip_per_stream_usd: Cents(1_000_000),
  max_tip_per_user_usd: Cents(1_000_000),
  max_sponsored_battle_usd: Cents(1_000_000),
  max_sponsorship_per_stream_usd: Cents(1_000_000),
  allow_site_leaderboards: z.literal(false).default(false),
  allow_code_leaderboards: z.literal(false).default(false),
}).superRefine((deal, ctx) => {
  const startMs = new Date(deal.week_start_utc).getTime();
  const endMs = new Date(deal.week_end_utc).getTime();
  const dayMs = 86_400_000;
  if (startMs % dayMs !== 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["week_start_utc"], message: "Deal start must be 00:00 UTC." });
  if (endMs % dayMs !== 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["week_end_utc"], message: "Deal end must be 00:00 UTC." });
  if (endMs <= startMs) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["week_end_utc"], message: "Deal end must be after its start." });
  }
  const durationDays = (endMs - startMs) / dayMs;
  if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 3650) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["week_end_utc"], message: "Deal duration must be 1 to 3650 whole UTC days." });
  if (deal.max_sponsorship_per_stream_usd < deal.max_sponsored_battle_usd) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["max_sponsorship_per_stream_usd"], message: "Per-stream sponsorship cap must cover at least one battle." });
  }
});

const RewardPayloadSchema = z.object({
  name: z.string().trim().min(2).max(80),
  codes: z.array(z.string().trim().min(1).max(32)).min(1).max(25),
  thresholdUsd: PositiveCents(1_000_000).nullable(),
  rewardUsd: PositiveCents(100_000).nullable(),
  vipRewardUsd: PositiveCents(100_000).nullable(),
  lossbackPct: PositiveCents(100).nullable(),
  minDepositUsd: PositiveCents(1_000_000).nullable(),
  maxRewardPerUserUsd: PositiveCents(1_000_000).nullable(),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
}).superRefine((reward, ctx) => {
  const wager = reward.thresholdUsd != null || reward.rewardUsd != null || reward.vipRewardUsd != null;
  const lossback = reward.lossbackPct != null || reward.minDepositUsd != null;
  if (!wager && !lossback) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Configure at least one reward leg." });
  if (wager && (reward.thresholdUsd == null || reward.rewardUsd == null)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Wager threshold and reward are both required." });
  if (reward.thresholdUsd != null && reward.rewardUsd != null && reward.rewardUsd >= reward.thresholdUsd) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Reward must be smaller than the wager threshold." });
  if (reward.vipRewardUsd != null && reward.thresholdUsd != null && reward.vipRewardUsd >= reward.thresholdUsd) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "VIP reward must be smaller than the wager threshold." });
  if (reward.vipRewardUsd != null && reward.rewardUsd != null && reward.vipRewardUsd < reward.rewardUsd) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "VIP reward must be at least the standard reward." });
  if (lossback && (reward.lossbackPct == null || reward.minDepositUsd == null)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Lossback percent and minimum deposit are both required." });
  if (reward.lossbackPct != null && reward.lossbackPct >= 100) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Lossback percent must be below 100%." });
});

export type CreatorDealApprovalStatus =
  | "pending_delivery" | "awaiting_continue" | "awaiting_decision"
  | "approved_provisioning" | "provisioning_failed" | "completed"
  | "declined" | "delivery_failed" | "cancelled" | "expired";

export class CreatorDealApprovalError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = "CreatorDealApprovalError";
  }
}

function error(status: number, code: string, message: string): never {
  throw new CreatorDealApprovalError(status, code, message);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function validateCreatorAndCodes(creatorUserId: string, codes: string[]): Promise<string[]> {
  const db = getProdReadDrizzleDb();
  const [creator, ownedRows] = await Promise.all([
    db.select({ id: user.id, role: user.role, roles: user.roles }).from(user).where(eq(user.id, creatorUserId)).limit(1),
    db.select({ code: affiliate_codes.code }).from(affiliate_codes).where(eq(affiliate_codes.user_id, creatorUserId)),
  ]);
  const account = creator[0];
  if (!account || (account.role !== "creator" && !(account.roles ?? []).includes("creator"))) {
    error(400, "creator_not_active", "That user is not an active creator.");
  }
  const normalized = [...new Set(codes.map((code) => code.trim().toUpperCase()))];
  const owned = new Set(ownedRows.map((row) => row.code.trim().toUpperCase()));
  const foreign = normalized.filter((code) => !owned.has(code));
  if (foreign.length > 0) error(400, "code_not_owned", `Not owned by this creator: ${foreign.join(", ")}`);
  return normalized;
}

type CreatorDealApprovalActor =
  | { kind: "creator"; linkedSiteUserId: null }
  | { kind: "admin"; linkedSiteUserId: string };

/**
 * Temporary approval override for a Discord account linked to an active Packy
 * site account with the `admin` site role. Discord guild roles are deliberately
 * not consulted: the MAIN account link and current site role are authoritative.
 */
async function resolveLinkedSiteAdmin(
  discordUserId: string,
): Promise<Extract<CreatorDealApprovalActor, { kind: "admin" }> | null> {
  const db = getProdReadDrizzleDb();
  const [linked] = await db
    .select({
      userId: user.id,
      role: user.role,
      roles: user.roles,
    })
    .from(account)
    .innerJoin(user, eq(user.id, account.userId))
    .where(and(
      eq(account.accountId, discordUserId),
      eq(account.providerId, "discord"),
    ))
    .limit(1);
  if (!linked || (linked.role !== "admin" && !(linked.roles ?? []).includes("admin"))) {
    return null;
  }
  return { kind: "admin", linkedSiteUserId: linked.userId };
}

export async function createCreatorDealApprovalRequest(input: {
  creatorUserId: string;
  dealPayload: unknown;
  rewardPayload?: unknown | null;
  submittedByAdminUserId: string;
}): Promise<{ requestId: string; status: CreatorDealApprovalStatus; deliveryQueued: boolean }> {
  const creatorUserId = UserId.parse(input.creatorUserId);
  const submittedBy = Uuid.parse(input.submittedByAdminUserId);
  const dealPayload = DealPayloadSchema.parse(input.dealPayload);
  const rawReward = input.rewardPayload ?? null;
  const rewardPayload = rawReward == null ? null : RewardPayloadSchema.parse(rawReward);
  const agreement = await getPublishedCreatorAgreementTerms();
  if (!agreement) error(409, "agreement_missing", "Publish creator agreement terms before submitting a deal.");

  const mainDb = getProdReadDrizzleDb();
  const [creator] = await mainDb.select({ id: user.id, role: user.role, roles: user.roles }).from(user).where(eq(user.id, creatorUserId)).limit(1);
  if (!creator || (creator.role !== "creator" && !(creator.roles ?? []).includes("creator"))) error(400, "creator_not_active", "That user is not an active creator.");
  const normalizedReward = rewardPayload
    ? {
        ...rewardPayload,
        // The reward program is part of this deal and may never outlive it.
        // Store the derived value in the immutable proposal so Discord and
        // provisioning disclose/use the exact same boundary.
        endsAt: dealPayload.week_end_utc,
        name: sanitizeProgramName(rewardPayload.name),
        codes: await validateCreatorAndCodes(creatorUserId, rewardPayload.codes),
      }
    : null;
  if (normalizedReward && normalizedReward.name.length < 2) error(400, "invalid_reward_name", "Program name has no usable characters.");

  const [setup] = await adminDrizzle.select().from(discord_creator_setups).where(and(
    eq(discord_creator_setups.creator_user_id, creatorUserId),
    eq(discord_creator_setups.status, "active"),
  )).limit(1);
  if (!setup?.category_id || !setup.chat_channel_id) error(409, "creator_setup_missing", "This creator needs an active linked Discord section first.");
  const categoryId = setup.category_id;
  const chatChannelId = setup.chat_channel_id;

  try {
    return await adminDrizzle.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`creator-deal-approval:${creatorUserId}`}, 0))`);
      const expired = await tx.execute<{ id: string }>(sql`
        UPDATE creator_deal_approval_requests
        SET status = 'expired', updated_at = now()
        WHERE creator_user_id = ${creatorUserId}
          AND status IN ('pending_delivery','awaiting_continue','awaiting_decision','delivery_failed')
          AND (deal_payload ->> 'week_end_utc')::timestamptz <= now()
        RETURNING id::text
      `);
      if (expired.rows.length > 0) {
        await tx.insert(creator_deal_approval_events).values(expired.rows.map((row) => ({
          request_id: row.id,
          event_type: "expired",
          actor_kind: "system",
          metadata: { reason: "deal_window_elapsed" },
        })));
      }
      const [existing] = await tx.select().from(creator_deal_approval_requests).where(and(
        eq(creator_deal_approval_requests.creator_user_id, creatorUserId),
        sql`${creator_deal_approval_requests.status} IN ('pending_delivery','awaiting_continue','awaiting_decision','approved_provisioning','provisioning_failed','delivery_failed')`,
      )).limit(1);
      if (existing) {
        if (jsonEqual(existing.deal_payload, dealPayload) && jsonEqual(existing.reward_payload, normalizedReward) && existing.agreement_checksum === agreement.checksum) {
          return { requestId: existing.id, status: existing.status as CreatorDealApprovalStatus, deliveryQueued: existing.status === "pending_delivery" };
        }
        error(409, "approval_in_progress", "This creator already has an unresolved deal approval.");
      }
      const requestValues: typeof creator_deal_approval_requests.$inferInsert = {
        creator_user_id: creatorUserId,
        discord_setup_id: setup.id,
        creator_discord_user_id: setup.creator_discord_user_id,
        guild_id: setup.guild_id,
        category_id: categoryId,
        chat_channel_id: chatChannelId,
        deal_payload: dealPayload,
        reward_payload: normalizedReward,
        agreement_document_id: agreement.id,
        agreement_version: agreement.version,
        agreement_lines: agreement.lines,
        agreement_checksum: agreement.checksum,
        submitted_by: submittedBy,
      };
      const [created] = await tx.insert(creator_deal_approval_requests).values(requestValues).returning({ id: creator_deal_approval_requests.id, status: creator_deal_approval_requests.status });
      await tx.insert(creator_deal_approval_events).values({ request_id: created.id, event_type: "submitted", actor_kind: "admin", actor_admin_user_id: submittedBy });
      await tx.insert(admin_audit_events).values({ admin_user_id: submittedBy, event_type: "creator_deal_approval_submitted", target_user_id: creatorUserId, metadata: { requestId: created.id, agreementVersion: agreement.version, agreementChecksum: agreement.checksum, hasRewardProgram: normalizedReward != null } });
      return { requestId: created.id, status: created.status as CreatorDealApprovalStatus, deliveryQueued: true };
    });
  } catch (cause) {
    if (cause instanceof CreatorDealApprovalError) throw cause;
    if (isPostgresError(cause, "23505")) error(409, "approval_in_progress", "This creator already has an unresolved deal approval.");
    throw cause;
  }
}

export type CreatorDealApprovalDeliveryJob = {
  id: string; requestId: string; leaseToken: string; guildId: string; categoryId: string;
  channelId: string; creatorDiscordUserId: string; creator: { userId: string; username: string | null };
  deal: unknown; rewards: unknown | null; terms: { version: number; lines: string[] }; attempt: number;
};

export async function claimCreatorDealApprovalJobs(input: { guildId: string; workerId: string; limit: number }): Promise<CreatorDealApprovalDeliveryJob[]> {
  const guildId = DiscordId.parse(input.guildId);
  const workerId = z.string().trim().min(1).max(120).parse(input.workerId);
  const limit = z.number().int().min(1).max(25).parse(input.limit);
  const result = await adminDrizzle.execute<{
    id: string; lease_token: string; guild_id: string; category_id: string; chat_channel_id: string;
    creator_discord_user_id: string; creator_user_id: string; deal_payload: unknown; reward_payload: unknown | null;
    agreement_version: number; agreement_lines: unknown; delivery_attempt_count: number;
  }>(sql`
    WITH exhausted AS (
      UPDATE creator_deal_approval_requests SET status = 'delivery_failed', delivery_lease_token = NULL,
        delivery_lease_owner = NULL, delivery_leased_until = NULL, last_error_step = 'discord_delivery',
        last_error_code = COALESCE(last_error_code, 'lease_expired'), updated_at = now()
      WHERE guild_id = ${guildId} AND status = 'pending_delivery' AND delivery_leased_until < now()
        AND delivery_attempt_count >= delivery_max_attempts RETURNING id
    ), exhausted_events AS (
      INSERT INTO creator_deal_approval_events (request_id, event_type, actor_kind, metadata)
      SELECT id, 'summary_delivery_exhausted', 'system', jsonb_build_object('reason', 'lease_expired')
      FROM exhausted RETURNING id
    ), candidates AS (
      SELECT id FROM creator_deal_approval_requests
      WHERE guild_id = ${guildId} AND status = 'pending_delivery' AND delivery_available_at <= now()
        AND delivery_attempt_count < delivery_max_attempts
        AND (delivery_leased_until IS NULL OR delivery_leased_until < now())
      ORDER BY delivery_available_at, created_at, id FOR UPDATE SKIP LOCKED LIMIT ${limit}
    )
    UPDATE creator_deal_approval_requests AS request SET delivery_attempt_count = request.delivery_attempt_count + 1,
      delivery_lease_token = gen_random_uuid(), delivery_lease_owner = ${workerId},
      delivery_leased_until = now() + interval '60 seconds', updated_at = now()
    FROM candidates WHERE request.id = candidates.id
    RETURNING request.id::text, request.delivery_lease_token::text AS lease_token, request.guild_id,
      request.category_id, request.chat_channel_id, request.creator_discord_user_id, request.creator_user_id,
      request.deal_payload, request.reward_payload, request.agreement_version, request.agreement_lines,
      request.delivery_attempt_count
  `);
  return result.rows.map((row) => {
    const deal = DealPayloadSchema.parse(row.deal_payload);
    const rewards = row.reward_payload == null ? null : RewardPayloadSchema.parse(row.reward_payload);
    return { id: row.id, requestId: row.id, leaseToken: row.lease_token, guildId: row.guild_id,
      categoryId: row.category_id, channelId: row.chat_channel_id, creatorDiscordUserId: row.creator_discord_user_id,
      creator: { userId: row.creator_user_id, username: null },
      deal: { ...deal, conversionRatePercent: deal.conversion_rate_bps / 100 },
      rewards: rewards ? { ...rewards, accrualStartAt: deal.week_start_utc } : null,
      terms: { version: row.agreement_version, lines: z.array(z.string()).parse(row.agreement_lines) },
      attempt: row.delivery_attempt_count };
  });
}

export async function acknowledgeCreatorDealApprovalJob(input: {
  id: string; guildId: string; leaseToken: string; status: "delivered" | "failed";
  discordMessageId?: string; errorCode?: string; errorMessage?: string;
}): Promise<{ status: "awaiting_continue" | "pending_delivery" | "delivery_failed" }> {
  const id = Uuid.parse(input.id); const guildId = DiscordId.parse(input.guildId); const lease = Uuid.parse(input.leaseToken);
  if (input.status === "delivered") {
    const messageId = DiscordId.parse(input.discordMessageId);
    const result = await adminDrizzle.transaction(async (tx) => {
      const updated = await tx.execute<{ id: string }>(sql`
        UPDATE creator_deal_approval_requests SET status = 'awaiting_continue', summary_message_id = ${messageId},
          delivery_lease_token = NULL, delivery_lease_owner = NULL, delivery_leased_until = NULL,
          last_error_step = NULL, last_error_code = NULL, last_error_message = NULL, updated_at = now()
        WHERE id = ${id}::uuid AND guild_id = ${guildId} AND delivery_lease_token = ${lease}::uuid
          AND status = 'pending_delivery' RETURNING id::text
      `);
      if (!updated.rows[0]) {
        const [already] = await tx.select({ status: creator_deal_approval_requests.status, summaryMessageId: creator_deal_approval_requests.summary_message_id })
          .from(creator_deal_approval_requests).where(and(eq(creator_deal_approval_requests.id, id), eq(creator_deal_approval_requests.guild_id, guildId))).limit(1);
        if (already?.status === "awaiting_continue" && already.summaryMessageId === messageId) return { status: "awaiting_continue" as const };
        error(409, "delivery_lease_lost", "Delivery lease is no longer active.");
      }
      await tx.insert(creator_deal_approval_events).values({ request_id: id, event_type: "summary_delivered", actor_kind: "bot", metadata: { discordMessageId: messageId } });
      return { status: "awaiting_continue" as const };
    });
    return result;
  }
  return adminDrizzle.transaction(async (tx) => {
    const result = await tx.execute<{ status: "pending_delivery" | "delivery_failed" }>(sql`
      UPDATE creator_deal_approval_requests SET status = CASE WHEN delivery_attempt_count >= delivery_max_attempts THEN 'delivery_failed' ELSE 'pending_delivery' END,
        delivery_available_at = now() + LEAST(300, power(2, LEAST(delivery_attempt_count, 8))::int) * interval '1 second',
        delivery_lease_token = NULL, delivery_lease_owner = NULL, delivery_leased_until = NULL,
        last_error_step = 'discord_delivery', last_error_code = ${input.errorCode?.slice(0, 80) ?? "delivery_failed"},
        last_error_message = ${input.errorMessage?.slice(0, 500) ?? "Discord delivery failed."}, updated_at = now()
      WHERE id = ${id}::uuid AND guild_id = ${guildId} AND delivery_lease_token = ${lease}::uuid
        AND status = 'pending_delivery' RETURNING status
    `);
    if (!result.rows[0]) error(409, "delivery_lease_lost", "Delivery lease is no longer active.");
    await tx.insert(creator_deal_approval_events).values({ request_id: id, event_type: "summary_delivery_failed", actor_kind: "bot", metadata: {
      status: result.rows[0].status, errorCode: input.errorCode?.slice(0, 80) ?? "delivery_failed",
      errorMessage: input.errorMessage?.slice(0, 500) ?? "Discord delivery failed.",
    } });
    return { status: result.rows[0].status };
  });
}

/** Explicit operator recovery/resend for a proposal that has not been decided. */
export async function retryCreatorDealApprovalDelivery(input: {
  requestId: string;
  actorAdminUserId: string;
}): Promise<{ status: "pending_delivery" }> {
  const requestId = Uuid.parse(input.requestId);
  const actorAdminUserId = Uuid.parse(input.actorAdminUserId);
  return adminDrizzle.transaction(async (tx) => {
    const rows = await tx.execute<{ status: string }>(sql`
      SELECT status FROM creator_deal_approval_requests
      WHERE id = ${requestId}::uuid
      FOR UPDATE
    `);
    const previousStatus = rows.rows[0]?.status;
    if (!previousStatus || !["delivery_failed", "awaiting_continue", "awaiting_decision"].includes(previousStatus)) {
      error(409, "delivery_not_retryable", "Only an undecided proposal can be resent.");
    }
    const [request] = await tx.update(creator_deal_approval_requests).set({
      status: "pending_delivery",
      summary_message_id: null,
      delivery_attempt_count: 0,
      delivery_available_at: new Date().toISOString(),
      delivery_lease_token: null,
      delivery_lease_owner: null,
      delivery_leased_until: null,
      last_error_step: null,
      last_error_code: null,
      last_error_message: null,
      continued_at: null,
      updated_at: new Date().toISOString(),
    }).where(and(
      eq(creator_deal_approval_requests.id, requestId),
      eq(creator_deal_approval_requests.status, previousStatus),
    )).returning({ creatorUserId: creator_deal_approval_requests.creator_user_id });
    if (!request) error(409, "delivery_not_retryable", "The proposal changed before it could be resent.");
    await tx.insert(creator_deal_approval_events).values({
      request_id: requestId,
      event_type: "summary_delivery_requeued",
      actor_kind: "admin",
      actor_admin_user_id: actorAdminUserId,
      metadata: { previousStatus, reason: previousStatus === "delivery_failed" ? "delivery_retry" : "message_resend" },
    });
    await tx.insert(admin_audit_events).values({
      admin_user_id: actorAdminUserId,
      event_type: "creator_deal_approval_delivery_requeued",
      target_user_id: request.creatorUserId,
      metadata: { requestId, previousStatus },
    });
    return { status: "pending_delivery" as const };
  });
}

function markerDeal(deal: CreatorDealResponse, requestId: string): boolean {
  const terms = deal.terms;
  return !!terms && typeof terms === "object" && (terms as Record<string, unknown>).creator_approval_request_id === requestId;
}

type ContinuityProgram = {
  id: string;
  name: string;
  codes: string[] | null;
  threshold_usd: string | null;
  reward_usd: string | null;
  vip_reward_usd: string | null;
  lossback_pct: string | null;
  min_deposit_usd: string | null;
  max_reward_per_user_usd: string | null;
};

/**
 * Continuing the SAME program is the only zero-reset path that does not need
 * to migrate claim basis. It is safe only when attribution and economics are
 * unchanged. Reusing after a threshold/rate/code change would retroactively
 * reprice old wager or alter which code switch resets a player's run.
 */
function continuityTermsMatch(program: ContinuityProgram, reward: z.infer<typeof RewardPayloadSchema>): boolean {
  return rewardProgramsCanContinue({
    codes: program.codes,
    thresholdUsd: program.threshold_usd,
    rewardUsd: program.reward_usd,
    vipRewardUsd: program.vip_reward_usd,
    lossbackPct: program.lossback_pct,
    minDepositUsd: program.min_deposit_usd,
    maxRewardPerUserUsd: program.max_reward_per_user_usd,
  }, {
    codes: reward.codes,
    thresholdUsd: reward.thresholdUsd,
    rewardUsd: reward.rewardUsd,
    vipRewardUsd: reward.vipRewardUsd,
    lossbackPct: reward.lossbackPct,
    minDepositUsd: reward.minDepositUsd,
    maxRewardPerUserUsd: reward.maxRewardPerUserUsd,
  });
}

async function continueAdjacentRewardProgram(input: {
  request: typeof creator_deal_approval_requests.$inferSelect;
  reward: z.infer<typeof RewardPayloadSchema>;
  deal: z.infer<typeof DealPayloadSchema>;
  windowStart: Date;
  windowEnd: Date;
}): Promise<string | null> {
  return adminDrizzle.transaction(async (tx) => {
    const candidates = await tx.execute<ContinuityProgram>(sql`
      SELECT id::text, name, codes, threshold_usd::text, reward_usd::text,
             vip_reward_usd::text, lossback_pct::text, min_deposit_usd::text,
             max_reward_per_user_usd::text
      FROM creator_reward_programs
      WHERE creator_user_id = ${input.request.creator_user_id}
        AND ends_at = ${input.deal.week_start_utc}::timestamptz
        AND is_active = true
        AND archived_at IS NULL
      ORDER BY created_at DESC, id DESC
      FOR UPDATE
    `);
    const prior = candidates.rows.find((candidate) => continuityTermsMatch(candidate, input.reward));
    if (!prior) return null;

    await tx.execute(sql`
      UPDATE creator_reward_programs
      SET name = ${sanitizeProgramName(input.reward.name)},
          ends_at = ${input.windowEnd.toISOString()}::timestamptz,
          updated_at = now()
      WHERE id = ${prior.id}::uuid
    `);
    const existingWindow = await tx.execute<{ id: string }>(sql`
      SELECT id::text FROM creator_reward_program_windows
      WHERE program_id = ${prior.id}::uuid
        AND started_at = ${input.windowStart.toISOString()}::timestamptz
        AND ended_at = ${input.windowEnd.toISOString()}::timestamptz
      LIMIT 1
    `);
    if (!existingWindow.rows[0]) {
      await tx.insert(creator_reward_program_windows).values({
        program_id: prior.id,
        started_at: input.windowStart.toISOString(),
        ended_at: input.windowEnd.toISOString(),
      });
    }
    await tx.update(creator_deal_approval_requests).set({
      reward_program_id: prior.id,
      updated_at: new Date().toISOString(),
    }).where(eq(creator_deal_approval_requests.id, input.request.id));
    await tx.insert(creator_deal_approval_events).values({
      request_id: input.request.id,
      event_type: "reward_program_continued",
      actor_kind: "system",
      metadata: {
        rewardProgramId: prior.id,
        priorDealEndedAt: input.deal.week_start_utc,
        nextDealEndsAt: input.windowEnd.toISOString(),
      },
    });
    return prior.id;
  });
}

function dealWindowsOverlap(
  existing: Pick<CreatorDealResponse, "week_start_utc" | "week_end_utc">,
  proposed: z.infer<typeof DealPayloadSchema>,
): boolean {
  const existingStart = new Date(existing.week_start_utc).getTime();
  const existingEnd = new Date(existing.week_end_utc).getTime();
  const proposedStart = new Date(proposed.week_start_utc).getTime();
  const proposedEnd = new Date(proposed.week_end_utc).getTime();
  if (![existingStart, existingEnd, proposedStart, proposedEnd].every(Number.isFinite)) {
    error(409, "backend_deal_window_invalid", "An existing creator deal has an invalid time window.");
  }
  // Half-open windows: [start, end). An end exactly equal to the next start is
  // valid, while every positive-duration intersection is rejected.
  return existingStart < proposedEnd && proposedStart < existingEnd;
}

async function listAllCreatorDeals(creatorUserId: string): Promise<CreatorDealResponse[]> {
  const deals: CreatorDealResponse[] = [];
  const limit = 100;
  for (let offset = 0; ;) {
    const page = await creatorsApi.listDeals(creatorUserId, { offset, limit });
    deals.push(...page.data);
    if (deals.length >= page.total) return deals;
    if (page.data.length === 0) {
      error(409, "backend_deal_history_incomplete", "Creator deal history could not be fully verified.");
    }
    // Advance by what the backend actually returned; it may enforce a lower
    // page-size ceiling than requested.
    offset += page.data.length;
    if (offset >= 10_000) {
      error(409, "backend_deal_history_too_large", "Creator deal history is too large to verify safely.");
    }
  }
}

async function ensureBackendDeal(request: typeof creator_deal_approval_requests.$inferSelect): Promise<string> {
  if (request.backend_deal_id) return request.backend_deal_id;
  const outcome = await adminDrizzle.transaction(async (tx): Promise<
    { ok: true; dealId: string } | { ok: false; cause: unknown }
  > => {
    // Serializes approval-worker attempts. The backend independently enforces
    // this invariant under its own per-creator database lock for every caller.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`creator-deal-window:${request.creator_user_id}`}, 0))`);
    const payload = DealPayloadSchema.parse(request.deal_payload);
    const listed = await listAllCreatorDeals(request.creator_user_id);
    const existing = listed.find((deal) => markerDeal(deal, request.id));
    if (existing) return { ok: true, dealId: existing.id };
    const overlap = listed.find((deal) =>
      (deal.status === "active" || deal.status === "scheduled")
      && dealWindowsOverlap(deal, payload));
    if (overlap) {
      error(
        409,
        "creator_deal_window_overlap",
        `Creator already has an ${overlap.status} deal during the proposed window.`,
      );
    }
    if (request.backend_create_attempted_at) {
      error(409, "backend_create_unconfirmed", "The original backend create attempt is not visible yet. It will not be repeated because its outcome may be ambiguous.");
    }
    const [claimed] = await tx.update(creator_deal_approval_requests).set({
      backend_create_attempted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).where(and(
      eq(creator_deal_approval_requests.id, request.id),
      sql`${creator_deal_approval_requests.backend_create_attempted_at} IS NULL`,
    )).returning({ id: creator_deal_approval_requests.id });
    if (!claimed) error(409, "backend_create_in_progress", "Another worker already started backend deal creation.");
    try {
      const created = await creatorsApi.createDeal(request.creator_user_id, {
        ...payload,
        terms: { creator_approval_request_id: request.id, agreement_version: request.agreement_version, agreement_checksum: request.agreement_checksum },
      } satisfies CreateDealInput);
      return { ok: true, dealId: created.id };
    } catch (cause) {
      // Commit the attempted-at marker even when the remote outcome is
      // ambiguous. A retry must reconcile by marker instead of creating twice.
      return { ok: false, cause };
    }
  });
  if (!outcome.ok) throw outcome.cause;
  return outcome.dealId;
}

async function ensureRewardProgram(request: typeof creator_deal_approval_requests.$inferSelect, approvedAt: Date): Promise<string | null> {
  if (!request.reward_payload) return null;
  if (request.reward_program_id) return request.reward_program_id;
  const reward = RewardPayloadSchema.parse(request.reward_payload);
  const deal = DealPayloadSchema.parse(request.deal_payload);
  const codes = await validateCreatorAndCodes(request.creator_user_id, reward.codes);
  const start = new Date(Math.max(new Date(deal.week_start_utc).getTime(), approvedAt.getTime()));
  // Re-derive from the immutable deal snapshot as a fail-closed guard for
  // proposals written before `reward_payload.endsAt` became mandatory.
  const end = new Date(deal.week_end_utc);
  if (end <= start) error(409, "reward_window_elapsed", "The reward program would end before it can begin.");
  const continuedProgramId = await continueAdjacentRewardProgram({
    request,
    reward,
    deal,
    windowStart: start,
    windowEnd: end,
  });
  if (continuedProgramId) return continuedProgramId;
  return adminDrizzle.transaction(async (tx) => {
    const [existing] = await tx.select({ id: creator_reward_programs.id }).from(creator_reward_programs)
      .where(eq(creator_reward_programs.source_approval_request_id, request.id)).limit(1);
    if (existing) return existing.id;
    const [program] = await tx.insert(creator_reward_programs).values({
      name: sanitizeProgramName(reward.name), creator_user_id: request.creator_user_id, codes,
      threshold_usd: reward.thresholdUsd == null ? null : String(reward.thresholdUsd),
      reward_usd: reward.rewardUsd == null ? null : String(reward.rewardUsd),
      vip_reward_usd: reward.vipRewardUsd == null ? null : String(reward.vipRewardUsd),
      lossback_pct: reward.lossbackPct == null ? null : String(reward.lossbackPct),
      min_deposit_usd: reward.minDepositUsd == null ? null : String(reward.minDepositUsd),
      max_reward_per_user_usd: reward.maxRewardPerUserUsd == null ? null : String(reward.maxRewardPerUserUsd),
      accrual_start_at: start.toISOString(), ends_at: end.toISOString(), created_by: request.submitted_by!,
      source_approval_request_id: request.id, is_active: true,
    }).returning({ id: creator_reward_programs.id });
    await tx.insert(creator_reward_program_windows).values({ program_id: program.id, started_at: start.toISOString(), ended_at: end.toISOString() });
    return program.id;
  });
}

export async function provisionApprovedCreatorDealRequest(
  requestId: string,
  actorAdminUserId?: string,
): Promise<{ status: "approved" | "failed" | "processing"; requestId: string }> {
  const id = Uuid.parse(requestId);
  const retryActor = actorAdminUserId ? Uuid.parse(actorAdminUserId) : null;
  const lease = await adminDrizzle.execute<{ id: string; provisioning_lease_token: string }>(sql`
    UPDATE creator_deal_approval_requests SET status = 'approved_provisioning', provisioning_attempt_count = provisioning_attempt_count + 1,
      provisioning_lease_token = gen_random_uuid(), provisioning_leased_until = now() + interval '90 seconds', updated_at = now()
    WHERE id = ${id}::uuid AND status IN ('approved_provisioning','provisioning_failed')
      AND (provisioning_leased_until IS NULL OR provisioning_leased_until < now())
    RETURNING id::text, provisioning_lease_token::text
  `);
  if (!lease.rows[0]) {
    const [current] = await adminDrizzle.select({ status: creator_deal_approval_requests.status }).from(creator_deal_approval_requests).where(eq(creator_deal_approval_requests.id, id)).limit(1);
    return {
      requestId: id,
      status: current?.status === "completed"
        ? "approved"
        : current?.status === "approved_provisioning"
          ? "processing"
          : "failed",
    };
  }
  const token = lease.rows[0].provisioning_lease_token;
  const [request] = await adminDrizzle.select().from(creator_deal_approval_requests).where(eq(creator_deal_approval_requests.id, id)).limit(1);
  try {
    await validateCreatorAndCodes(request.creator_user_id, []);
    if (retryActor) {
      await adminDrizzle.transaction(async (tx) => {
        await tx.insert(creator_deal_approval_events).values({ request_id: id, event_type: "provisioning_retried", actor_kind: "admin", actor_admin_user_id: retryActor });
        await tx.insert(admin_audit_events).values({ admin_user_id: retryActor, event_type: "creator_deal_approval_provisioning_retried", target_user_id: request.creator_user_id, metadata: { requestId: id } });
      });
    }
    const approvedAt = request.approved_at ? new Date(request.approved_at) : new Date();
    const deal = DealPayloadSchema.parse(request.deal_payload);
    if (new Date(deal.week_end_utc) <= approvedAt) error(409, "deal_window_elapsed", "The approved deal has already ended.");
    const backendDealId = await ensureBackendDeal(request);
    await adminDrizzle.update(creator_deal_approval_requests).set({ backend_deal_id: backendDealId, updated_at: new Date().toISOString() }).where(and(eq(creator_deal_approval_requests.id, id), eq(creator_deal_approval_requests.provisioning_lease_token, token)));
    const rewardProgramId = await ensureRewardProgram({ ...request, backend_deal_id: backendDealId }, approvedAt);
    await adminDrizzle.transaction(async (tx) => {
      const completed = await tx.execute<{ creator_user_id: string }>(sql`
        UPDATE creator_deal_approval_requests SET status = 'completed', backend_deal_id = ${backendDealId}, reward_program_id = ${rewardProgramId}::uuid,
          provisioning_lease_token = NULL, provisioning_leased_until = NULL, last_error_step = NULL,
          last_error_code = NULL, last_error_message = NULL, completed_at = now(), updated_at = now()
        WHERE id = ${id}::uuid AND provisioning_lease_token = ${token}::uuid RETURNING creator_user_id
      `);
      if (!completed.rows[0]) error(409, "provisioning_lease_lost", "Provisioning lease expired.");
      await tx.insert(creator_deal_approval_events).values({ request_id: id, event_type: "provisioned", actor_kind: "system", metadata: { backendDealId, rewardProgramId } });
      await tx.insert(admin_audit_events).values({ admin_user_id: request.submitted_by, event_type: "creator_deal_approval_provisioned", target_user_id: request.creator_user_id, metadata: { requestId: id, backendDealId, rewardProgramId } });
    });
    return { status: "approved", requestId: id };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Provisioning failed.";
    await adminDrizzle.transaction(async (tx) => {
      const failed = await tx.execute<{ last_error_step: string }>(sql`
        UPDATE creator_deal_approval_requests SET status = 'provisioning_failed', provisioning_lease_token = NULL,
          provisioning_leased_until = NULL, last_error_step = CASE WHEN backend_deal_id IS NULL THEN 'backend_deal' ELSE 'reward_program' END,
          last_error_code = ${cause instanceof CreatorDealApprovalError ? cause.code : "provisioning_error"},
          last_error_message = ${message.slice(0, 500)}, updated_at = now()
        WHERE id = ${id}::uuid AND provisioning_lease_token = ${token}::uuid RETURNING last_error_step
      `);
      if (failed.rows[0]) await tx.insert(creator_deal_approval_events).values({ request_id: id, event_type: "provisioning_failed", actor_kind: "system", metadata: {
        step: failed.rows[0].last_error_step,
        code: cause instanceof CreatorDealApprovalError ? cause.code : "provisioning_error",
        message: message.slice(0, 500),
      } });
    });
    return { status: "failed", requestId: id };
  }
}

export type CreatorDealApprovalResponse = { status: "awaiting_decision" | "processing" | "approved" | "declined" | "failed" | "expired"; requestId: string; terms?: { version: number; lines: string[]; checksum: string } };

export async function respondToCreatorDealApproval(input: {
  requestId: string; guildId: string; categoryId: string; channelId: string; messageId: string;
  actorDiscordUserId: string; interactionId: string; action: "continue" | "approve" | "decline";
}): Promise<CreatorDealApprovalResponse> {
  const parsed = z.object({ requestId: Uuid, guildId: DiscordId, categoryId: DiscordId, channelId: DiscordId,
    messageId: DiscordId, actorDiscordUserId: DiscordId, interactionId: DiscordId,
    action: z.enum(["continue", "approve", "decline"]) }).parse(input);

  // A proposal snapshot is immutable, but authorization is not. A creator
  // whose site role or linked Discord setup was revoked must not retain an old
  // approval button as a durable capability.
  const [candidate] = await adminDrizzle.select({ creatorUserId: creator_deal_approval_requests.creator_user_id })
      .from(creator_deal_approval_requests)
      .where(eq(creator_deal_approval_requests.id, parsed.requestId))
      .limit(1);
  if (!candidate) error(404, "approval_not_found", "Deal approval request not found.");
  await validateCreatorAndCodes(candidate.creatorUserId, []);

  const transition = await adminDrizzle.transaction(async (tx) => {
    const rows = await tx.execute<typeof creator_deal_approval_requests.$inferSelect>(sql`SELECT * FROM creator_deal_approval_requests WHERE id = ${parsed.requestId}::uuid FOR UPDATE`);
    const request = rows.rows[0];
    if (!request) error(404, "approval_not_found", "Deal approval request not found.");
    if (request.guild_id !== parsed.guildId || request.category_id !== parsed.categoryId || request.chat_channel_id !== parsed.channelId || request.summary_message_id !== parsed.messageId) error(403, "approval_context_forbidden", "This button is not bound to this creator deal message.");
    // Resolve a possible override only after the canonical request is locked,
    // so the site-role check is as close as possible to the decision write.
    const linkedSiteAdmin = request.creator_discord_user_id === parsed.actorDiscordUserId
      ? null
      : await resolveLinkedSiteAdmin(parsed.actorDiscordUserId);
    const actor: CreatorDealApprovalActor =
      request.creator_discord_user_id === parsed.actorDiscordUserId
        ? { kind: "creator", linkedSiteUserId: null }
        : linkedSiteAdmin ?? error(
            403,
            "approval_actor_forbidden",
            "Only the creator assigned to this channel or a linked site admin can respond.",
          );
    // Declining remains an exclusively creator-owned decision. The temporary
    // admin override can present the terms and approve, but cannot reject a
    // creator's proposal on their behalf.
    if (parsed.action === "decline" && actor.kind !== "creator") {
      error(403, "approval_actor_forbidden", "Only the creator assigned to this channel can decline.");
    }
    const [activeSetup] = await tx.select({ id: discord_creator_setups.id }).from(discord_creator_setups).where(and(
      eq(discord_creator_setups.id, request.discord_setup_id),
      eq(discord_creator_setups.status, "active"),
      eq(discord_creator_setups.creator_user_id, request.creator_user_id),
      eq(discord_creator_setups.creator_discord_user_id, request.creator_discord_user_id),
      eq(discord_creator_setups.guild_id, parsed.guildId),
      eq(discord_creator_setups.category_id, parsed.categoryId),
      eq(discord_creator_setups.chat_channel_id, parsed.channelId),
    )).limit(1);
    if (!activeSetup) error(403, "creator_setup_revoked", "This creator's linked Discord setup is no longer active.");

    const prior = await tx.select({ id: creator_deal_approval_events.id, metadata: creator_deal_approval_events.metadata })
      .from(creator_deal_approval_events).where(eq(creator_deal_approval_events.interaction_id, parsed.interactionId)).limit(1);
    if (prior[0]) return request;

    const dealWindow = DealPayloadSchema.parse(request.deal_payload);
    if (
      new Date(dealWindow.week_end_utc).getTime() <= Date.now()
      && ["pending_delivery", "awaiting_continue", "awaiting_decision", "delivery_failed"].includes(request.status)
    ) {
      const [expired] = await tx.update(creator_deal_approval_requests).set({
        status: "expired",
        updated_at: new Date().toISOString(),
      }).where(eq(creator_deal_approval_requests.id, request.id)).returning();
      await tx.insert(creator_deal_approval_events).values({
        request_id: request.id,
        event_type: "expired",
        actor_kind: "system",
        actor_discord_user_id: parsed.actorDiscordUserId,
        interaction_id: parsed.interactionId,
        metadata: { reason: "deal_window_elapsed" },
      });
      return expired;
    }

    if (parsed.action === "continue") {
      if (request.status !== "awaiting_continue") {
        if (["awaiting_decision", "completed", "declined", "provisioning_failed", "approved_provisioning"].includes(request.status)) return request;
        error(409, "invalid_transition", "This proposal cannot continue from its current state.");
      }
      const [updated] = await tx.update(creator_deal_approval_requests).set({ status: "awaiting_decision", continued_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .where(and(eq(creator_deal_approval_requests.id, request.id), eq(creator_deal_approval_requests.status, "awaiting_continue"))).returning();
      await tx.insert(creator_deal_approval_events).values({
        request_id: request.id,
        event_type: "terms_presented",
        actor_kind: actor.kind,
        actor_discord_user_id: parsed.actorDiscordUserId,
        interaction_id: parsed.interactionId,
        metadata: {
          action: parsed.action,
          approvalActor: actor.kind,
          ...(actor.kind === "admin" ? { linkedSiteUserId: actor.linkedSiteUserId } : {}),
        },
      });
      return updated;
    }
    if (request.status !== "awaiting_decision") {
      if (["completed", "declined", "provisioning_failed", "approved_provisioning"].includes(request.status)) return request;
      error(409, "invalid_transition", "A creator must continue to the agreement before deciding.");
    }
    const now = new Date().toISOString();
    const next = parsed.action === "approve" ? "approved_provisioning" : "declined";
    const [updated] = await tx.update(creator_deal_approval_requests).set({ status: next,
      decision_interaction_id: parsed.interactionId, decision_actor_discord_user_id: parsed.actorDiscordUserId,
      approved_at: parsed.action === "approve" ? now : null, declined_at: parsed.action === "decline" ? now : null,
      updated_at: now }).where(and(eq(creator_deal_approval_requests.id, request.id), eq(creator_deal_approval_requests.status, "awaiting_decision"))).returning();
    await tx.insert(creator_deal_approval_events).values({
      request_id: request.id,
      event_type: parsed.action === "approve" ? "approved" : "declined",
      actor_kind: actor.kind,
      actor_discord_user_id: parsed.actorDiscordUserId,
      interaction_id: parsed.interactionId,
      metadata: {
        action: parsed.action,
        approvalActor: actor.kind,
        ...(actor.kind === "admin" ? { linkedSiteUserId: actor.linkedSiteUserId } : {}),
      },
    });
    await tx.insert(admin_audit_events).values({
      admin_user_id: null,
      event_type: parsed.action === "approve" ? "creator_deal_approval_approved" : "creator_deal_approval_declined",
      target_user_id: request.creator_user_id,
      metadata: {
        requestId: request.id,
        actorDiscordUserId: parsed.actorDiscordUserId,
        interactionId: parsed.interactionId,
        approvalActor: actor.kind,
        ...(actor.kind === "admin" ? { linkedSiteUserId: actor.linkedSiteUserId } : {}),
      },
    });
    return updated;
  });

  if (parsed.action === "continue") {
    if (transition.status === "expired") return { status: "expired", requestId: parsed.requestId };
    if (transition.status === "completed") return { status: "approved", requestId: parsed.requestId };
    if (transition.status === "declined") return { status: "declined", requestId: parsed.requestId };
    if (transition.status === "provisioning_failed") return { status: "failed", requestId: parsed.requestId };
    return { status: "awaiting_decision", requestId: parsed.requestId, terms: { version: transition.agreement_version, lines: z.array(z.string()).parse(transition.agreement_lines), checksum: transition.agreement_checksum } };
  }
  if (parsed.action === "decline" || transition.status === "declined") return { status: "declined", requestId: parsed.requestId };
  if (transition.status === "expired") return { status: "expired", requestId: parsed.requestId };
  if (transition.status === "completed") return { status: "approved", requestId: parsed.requestId };
  const provisioned = await provisionApprovedCreatorDealRequest(parsed.requestId);
  return { status: provisioned.status, requestId: parsed.requestId };
}
