import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";

import { adminDrizzle } from "@/lib/admin-db";
import { creatorsApi, type CreateDealInput, type CreatorDealResponse } from "@/lib/backend-api";
import {
  multiplierDealsApi,
  type CreateMultiplierDealInput,
  type MultiplierDealResponse,
} from "@/lib/backend-api/multiplier-deals";
import { affiliateLeaderboardsApi } from "@/lib/backend-api/affiliate-leaderboards";
import {
  admin_audit_events,
  admin_leaderboard_sponsorship,
  creator_deal_approval_events,
  creator_deal_approval_requests,
  creator_pnl_deals,
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
import { buildBackendDealPeriods } from "@/lib/creator-deal-periods";
import {
  snapshotPnlMultiplierFunding,
  type PnlMultiplierFundingSnapshot,
} from "@/lib/creator-pnl-funding-snapshot";
import {
  CREATOR_PNL_MAX_FRAME_DAYS,
  CREATOR_PNL_MAX_MULTIPLIER_BPS,
  creatorPnlFrameDurationDays,
} from "@/lib/creator-pnl-contract";
import {
  creatorApprovalWindowHasEnded,
  hasAllCreatorApprovalAssets,
} from "@/lib/creator-deal-provisioning-window";
import { matchingApprovedLeaderboards } from "@/lib/creator-leaderboard-reconciliation";

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
  withdraw_cap_period_days: z.union([z.literal(7), z.literal(14)]).nullable().optional(),
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
  if (deal.withdraw_cap_period_days != null) {
    if (deal.total_withdraw_cap_usd === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["withdraw_cap_period_days"], message: "An uncapped deal cannot have a withdrawal-cap period." });
    }
    if (durationDays < deal.withdraw_cap_period_days || durationDays % deal.withdraw_cap_period_days !== 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["withdraw_cap_period_days"], message: "Deal duration must be evenly divisible by its withdrawal-cap period." });
    }
  }
  if (deal.max_sponsorship_per_stream_usd < deal.max_sponsored_battle_usd) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["max_sponsorship_per_stream_usd"], message: "Per-stream sponsorship cap must cover at least one battle." });
  }
});

const MultiplierPayloadSchema = z.object({
  approval_expires_at: z.string().datetime({ offset: true }),
  required_deposit_usd: PositiveCents(1_000_000),
  multiplier_bps: z.number().int().min(10_000).max(10_000_000),
  withdrawable_bps: z.number().int().min(0).max(10_000),
  wager_requirement_bps: z.number().int().min(0).max(10_000_000),
  max_total_wager_usd: Cents(10_000_000).nullable(),
  max_payout_usd: Cents(10_000_000).nullable(),
  min_session_duration_seconds: z.number().int().min(0).max(31_536_000),
  min_bet_count: z.number().int().min(0).max(10_000_000),
  min_wager_to_funding_ratio_bps: z.number().int().min(0).max(10_000),
  kick_vod_required: z.boolean(),
  auto_renew: z.boolean(),
}).superRefine((deal, ctx) => {
  if (deal.withdrawable_bps !== Math.round(100_000_000 / deal.multiplier_bps)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["withdrawable_bps"], message: "Withdrawable percentage must equal 100 divided by the multiplier." });
  }
});

const PnlPayloadSchema = z.object({
  frame_start_utc: z.string().datetime({ offset: true }),
  frame_end_utc: z.string().datetime({ offset: true }),
  positive_pnl_share_bps: z.number().int().min(1).max(10_000),
  funding: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("non_withdrawable_fills"),
      fills_allowed: z.number().int().positive().max(10_000),
      per_fill_amount_usd: PositiveCents(1_000_000),
      cooldown_minutes: z.number().int().min(0).max(525_600).optional(),
    }),
    z.object({
      type: z.literal("linked_multiplier"),
      multiplier_deal_id: Uuid,
    }),
    z.object({
      type: z.literal("new_multiplier"),
      required_deposit_usd: PositiveCents(1_000_000),
      multiplier_bps: z.number().int().min(20_000).max(CREATOR_PNL_MAX_MULTIPLIER_BPS),
      withdrawable_bps: z.number().int().min(0).max(10_000),
      wager_requirement_bps: z.number().int().min(0).max(10_000_000),
      max_total_wager_usd: Cents(10_000_000).nullable(),
      max_payout_usd: Cents(10_000_000).nullable(),
      min_session_duration_seconds: z.number().int().min(0).max(31_536_000),
      min_bet_count: z.number().int().min(0).max(10_000_000),
      min_wager_to_funding_ratio_bps: z.number().int().min(0).max(10_000),
      kick_vod_required: z.boolean(),
      // A nested multiplier funds one fixed P&L frame. It must never renew
      // into a later frame without a new immutable creator approval.
      auto_renew: z.literal(false),
    }).superRefine((funding, ctx) => {
      if (funding.withdrawable_bps !== Math.round(100_000_000 / funding.multiplier_bps)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["withdrawable_bps"], message: "Withdrawable percentage must equal 100 divided by the multiplier." });
      }
    }),
  ]),
  max_tip_per_stream_usd: Cents(1_000_000).optional(),
  max_tip_per_user_usd: Cents(1_000_000).optional(),
  max_sponsored_battle_usd: Cents(1_000_000).optional(),
  max_sponsorship_per_stream_usd: Cents(1_000_000).optional(),
}).superRefine((deal, ctx) => {
  const startMs = new Date(deal.frame_start_utc).getTime();
  const endMs = new Date(deal.frame_end_utc).getTime();
  if (endMs <= startMs) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["frame_end_utc"], message: "P&L frame end must be after its start." });
  }
  const durationDays = creatorPnlFrameDurationDays(deal.frame_start_utc, deal.frame_end_utc);
  if (!Number.isFinite(durationDays) || durationDays < 1 || durationDays > CREATOR_PNL_MAX_FRAME_DAYS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["frame_end_utc"],
      message: `P&L frame duration must be 1 to ${CREATOR_PNL_MAX_FRAME_DAYS} days.`,
    });
  }
  if (
    deal.max_sponsorship_per_stream_usd != null
    && deal.max_sponsored_battle_usd != null
    && deal.max_sponsorship_per_stream_usd < deal.max_sponsored_battle_usd
  ) {
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
  // Both are derived server-side from the request window: for a deal request
  // from the deal, for a standalone rewards request from its own inputs.
  startsAt: z.string().datetime({ offset: true }).nullable().optional(),
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

/**
 * A site-funded affiliate leaderboard bundled into an approval request.
 *
 * `codes`, `startsAt` and `endsAt` are always re-derived server-side — the
 * codes from the creator's current affiliate codes, the window from the deal
 * (bundled) or from the request's own window (standalone). Whatever the client
 * sends for those three is treated as untrusted and overwritten.
 */
const LeaderboardPayloadSchema = z.object({
  title: z.string().trim().min(2).max(100),
  prizeTiers: z.array(z.object({
    position: z.number().int().positive().max(10_000),
    prizeAmountUsd: PositiveCents(1_000_000),
  })).min(5, "At least 5 prize tiers are required.").max(200),
  siteBonusUsd: PositiveCents(10_000_000),
  sponsoredPct: z.number().finite().min(0).max(100),
  codes: z.array(z.string().trim().min(1).max(32)).min(1).max(25),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
}).superRefine((board, ctx) => {
  const positions = new Set(board.prizeTiers.map((tier) => tier.position));
  if (positions.size !== board.prizeTiers.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["prizeTiers"], message: "Prize positions must be unique." });
  }
  const tierSum = board.prizeTiers.reduce((total, tier) => total + tier.prizeAmountUsd, 0);
  if (tierSum > board.siteBonusUsd + 1e-6) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["prizeTiers"], message: "Prize tiers cannot exceed the total prize pool." });
  }
  if (new Date(board.endsAt).getTime() <= new Date(board.startsAt).getTime()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endsAt"], message: "Leaderboard end must be after its start." });
  }
});

export type CreatorApprovalRequestKind = "deal" | "multiplier_deal" | "pnl_deal" | "leaderboard_only" | "rewards_only";

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

/**
 * Every affiliate code the creator currently owns. Leaderboards always run on
 * the creator's full code set, so there is no client-supplied selection to
 * trust — this read is the only source.
 */
async function loadAllCreatorCodes(creatorUserId: string): Promise<string[]> {
  const db = getProdReadDrizzleDb();
  const rows = await db
    .select({ code: affiliate_codes.code })
    .from(affiliate_codes)
    .where(eq(affiliate_codes.user_id, creatorUserId));
  const codes = [...new Set(rows.map((row) => row.code.trim().toUpperCase()))].filter(Boolean);
  if (codes.length === 0) error(400, "creator_codes_missing", "This creator has no affiliate codes, so a leaderboard cannot be created.");
  return codes;
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
  dealPayload?: unknown | null;
  multiplierPayload?: unknown | null;
  pnlPayload?: unknown | null;
  rewardPayload?: unknown | null;
  leaderboardPayload?: unknown | null;
  submittedByAdminUserId: string;
}): Promise<{ requestId: string; status: CreatorDealApprovalStatus; deliveryQueued: boolean; kind: CreatorApprovalRequestKind }> {
  const creatorUserId = UserId.parse(input.creatorUserId);
  const submittedBy = Uuid.parse(input.submittedByAdminUserId);
  const rawDeal = input.dealPayload ?? null;
  const rawMultiplier = input.multiplierPayload ?? null;
  const rawPnl = input.pnlPayload ?? null;
  const rawReward = input.rewardPayload ?? null;
  const rawLeaderboard = input.leaderboardPayload ?? null;

  // The kind is inferred, never taken from the client. A non-deal request must
  // carry exactly one payload — the same invariant the table CHECK enforces.
  const kind: CreatorApprovalRequestKind =
    rawDeal != null && rawMultiplier == null && rawPnl == null
      ? "deal"
      : rawMultiplier != null && rawDeal == null && rawPnl == null && rawReward == null && rawLeaderboard == null
        ? "multiplier_deal"
      : rawPnl != null && rawDeal == null && rawMultiplier == null
        ? "pnl_deal"
      : rawLeaderboard != null && rawReward == null && rawDeal == null && rawMultiplier == null && rawPnl == null
        ? "leaderboard_only"
        : rawReward != null && rawLeaderboard == null && rawDeal == null && rawMultiplier == null && rawPnl == null
          ? "rewards_only"
          : error(400, "invalid_request_payload", "Submit either a fill deal, a multiplier deal, a P&L deal, or exactly one standalone leaderboard or reward program.");

  const dealPayload = rawDeal == null ? null : DealPayloadSchema.parse(rawDeal);
  const multiplierPayload = rawMultiplier == null ? null : MultiplierPayloadSchema.parse(rawMultiplier);
  const pnlPayload = rawPnl == null ? null : PnlPayloadSchema.parse(rawPnl);
  const rewardPayload = rawReward == null ? null : RewardPayloadSchema.parse(rawReward);
  const leaderboardPayload = rawLeaderboard == null ? null : LeaderboardPayloadSchema.parse(rawLeaderboard);
  const agreement = await getPublishedCreatorAgreementTerms();
  if (!agreement) error(409, "agreement_missing", "Publish creator agreement terms before submitting a deal.");
  if (multiplierPayload && agreement.lines.join("\n").length > 20_000) {
    error(409, "agreement_too_long", "The published agreement is too long for a multiplier deal. Publish a version under 20,000 characters first.");
  }
  if (pnlPayload?.funding.type === "new_multiplier" && agreement.lines.join("\n").length > 20_000) {
    error(409, "agreement_too_long", "The published agreement is too long for new multiplier funding. Publish a version under 20,000 characters first.");
  }

  const mainDb = getProdReadDrizzleDb();
  const [creator] = await mainDb.select({ id: user.id, role: user.role, roles: user.roles }).from(user).where(eq(user.id, creatorUserId)).limit(1);
  if (!creator || (creator.role !== "creator" && !(creator.roles ?? []).includes("creator"))) error(400, "creator_not_active", "That user is not an active creator.");

  // The canonical window every downstream step reads. A deal owns the window
  // it declares; a standalone request owns the window on its own payload.
  const windowStartIso = dealPayload
    ? dealPayload.week_start_utc
    : multiplierPayload
      ? new Date().toISOString()
    : pnlPayload
      ? pnlPayload.frame_start_utc
    : leaderboardPayload
      ? leaderboardPayload.startsAt
      : rewardPayload?.startsAt ?? error(400, "reward_window_missing", "Enter a start date for this reward program.");
  const windowEndIso = dealPayload
    ? dealPayload.week_end_utc
    : multiplierPayload
      ? multiplierPayload.approval_expires_at
    : pnlPayload
      ? pnlPayload.frame_end_utc
    : leaderboardPayload
      ? leaderboardPayload.endsAt
      : rewardPayload?.endsAt ?? error(400, "reward_window_missing", "Enter an end date for this reward program.");
  if (new Date(windowEndIso).getTime() <= new Date(windowStartIso).getTime()) {
    error(400, "invalid_window", "The end of this request must be after its start.");
  }
  if (new Date(windowEndIso).getTime() <= Date.now()) {
    error(400, "window_elapsed", "This request would end before it could be approved.");
  }

  const normalizedReward = rewardPayload
    ? {
        ...rewardPayload,
        // The reward program is part of this deal and may never outlive it.
        // Store the derived value in the immutable proposal so Discord and
        // provisioning disclose/use the exact same boundary.
        startsAt: dealPayload ? dealPayload.week_start_utc : windowStartIso,
        endsAt: dealPayload ? dealPayload.week_end_utc : windowEndIso,
        name: sanitizeProgramName(rewardPayload.name),
        codes: await validateCreatorAndCodes(creatorUserId, rewardPayload.codes),
      }
    : null;
  if (normalizedReward && normalizedReward.name.length < 2) error(400, "invalid_reward_name", "Program name has no usable characters.");
  // A leaderboard always runs on the creator's full current code set and on
  // the request's own window — client values for both are discarded.
  const normalizedLeaderboard = leaderboardPayload
    ? {
        ...leaderboardPayload,
        codes: await loadAllCreatorCodes(creatorUserId),
        startsAt: windowStartIso,
        endsAt: windowEndIso,
      }
    : null;

  const [setup] = await adminDrizzle.select().from(discord_creator_setups).where(and(
    eq(discord_creator_setups.creator_user_id, creatorUserId),
    eq(discord_creator_setups.status, "active"),
  )).limit(1);
  if (!setup?.category_id || !setup.chat_channel_id) error(409, "creator_setup_missing", "This creator needs an active linked Discord section first.");
  const categoryId = setup.category_id;
  const chatChannelId = setup.chat_channel_id;

  try {
    return await adminDrizzle.transaction(async (tx) => {
      const requestFamily = kind === "deal" || kind === "multiplier_deal" || kind === "pnl_deal" ? "deal" : kind;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`creator-deal-approval:${requestFamily}:${creatorUserId}`}, 0))`);
      const expired = await tx.execute<{ id: string }>(sql`
        UPDATE creator_deal_approval_requests
        SET status = 'expired', updated_at = now()
        WHERE creator_user_id = ${creatorUserId}
          AND ${requestFamily === "deal" ? sql`request_kind IN ('deal', 'multiplier_deal', 'pnl_deal')` : sql`request_kind = ${kind}`}
          AND status IN ('pending_delivery','awaiting_continue','awaiting_decision','delivery_failed')
          AND window_end_at <= now()
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
        requestFamily === "deal"
          ? sql`${creator_deal_approval_requests.request_kind} IN ('deal', 'multiplier_deal', 'pnl_deal')`
          : eq(creator_deal_approval_requests.request_kind, kind),
        sql`${creator_deal_approval_requests.status} IN ('pending_delivery','awaiting_continue','awaiting_decision','approved_provisioning','provisioning_failed','delivery_failed')`,
      )).limit(1);
      if (existing) {
        if (
          jsonEqual(existing.deal_payload, dealPayload)
          && jsonEqual(existing.multiplier_payload, multiplierPayload)
          && jsonEqual(existing.pnl_payload, pnlPayload)
          && jsonEqual(existing.reward_payload, normalizedReward)
          && jsonEqual(existing.leaderboard_payload, normalizedLeaderboard)
          && existing.agreement_checksum === agreement.checksum
        ) {
          return { requestId: existing.id, status: existing.status as CreatorDealApprovalStatus, deliveryQueued: existing.status === "pending_delivery", kind };
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
        request_kind: kind,
        window_start_at: windowStartIso,
        window_end_at: windowEndIso,
        deal_payload: dealPayload,
        multiplier_payload: multiplierPayload,
        pnl_payload: pnlPayload,
        reward_payload: normalizedReward,
        leaderboard_payload: normalizedLeaderboard,
        agreement_document_id: agreement.id,
        agreement_version: agreement.version,
        agreement_lines: agreement.lines,
        agreement_checksum: agreement.checksum,
        submitted_by: submittedBy,
      };
      const [created] = await tx.insert(creator_deal_approval_requests).values(requestValues).returning({ id: creator_deal_approval_requests.id, status: creator_deal_approval_requests.status });
      await tx.insert(creator_deal_approval_events).values({ request_id: created.id, event_type: "submitted", actor_kind: "admin", actor_admin_user_id: submittedBy });
      await tx.insert(admin_audit_events).values({ admin_user_id: submittedBy, event_type: "creator_deal_approval_submitted", target_user_id: creatorUserId, metadata: { requestId: created.id, requestKind: kind, agreementVersion: agreement.version, agreementChecksum: agreement.checksum, hasMultiplierDeal: multiplierPayload != null, hasPnlDeal: pnlPayload != null, hasRewardProgram: normalizedReward != null, hasLeaderboard: normalizedLeaderboard != null } });
      return { requestId: created.id, status: created.status as CreatorDealApprovalStatus, deliveryQueued: true, kind };
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
  /** Tells the bot what to render and whether a terms step exists at all. */
  kind: CreatorApprovalRequestKind;
  deal: unknown | null; multiplier: unknown | null; pnl: unknown | null; rewards: unknown | null; leaderboard: unknown | null;
  /** Always sent, but only meaningful for fill, multiplier, and P&L deals. */
  terms: { version: number; lines: string[] }; attempt: number;
  previousMessageId: string | null;
};

export async function claimCreatorDealApprovalJobs(input: { guildId: string; workerId: string; limit: number }): Promise<CreatorDealApprovalDeliveryJob[]> {
  const guildId = DiscordId.parse(input.guildId);
  const workerId = z.string().trim().min(1).max(120).parse(input.workerId);
  const limit = z.number().int().min(1).max(25).parse(input.limit);
  const result = await adminDrizzle.execute<{
    id: string; lease_token: string; guild_id: string; category_id: string; chat_channel_id: string;
    creator_discord_user_id: string; creator_user_id: string; request_kind: CreatorApprovalRequestKind;
    deal_payload: unknown | null; multiplier_payload: unknown | null; pnl_payload: unknown | null; reward_payload: unknown | null; leaderboard_payload: unknown | null;
    window_start_at: string; window_end_at: string;
    agreement_version: number; agreement_lines: unknown; delivery_attempt_count: number; summary_message_id: string | null;
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
      request.request_kind, request.deal_payload, request.multiplier_payload, request.pnl_payload, request.reward_payload, request.leaderboard_payload,
      request.window_start_at, request.window_end_at, request.agreement_version, request.agreement_lines,
      request.delivery_attempt_count, request.summary_message_id
  `);
  return result.rows.map((row) => {
    const deal = row.deal_payload == null ? null : DealPayloadSchema.parse(row.deal_payload);
    const multiplier = row.multiplier_payload == null ? null : MultiplierPayloadSchema.parse(row.multiplier_payload);
    const pnl = row.pnl_payload == null ? null : PnlPayloadSchema.parse(row.pnl_payload);
    const rewards = row.reward_payload == null ? null : RewardPayloadSchema.parse(row.reward_payload);
    const leaderboard = row.leaderboard_payload == null ? null : LeaderboardPayloadSchema.parse(row.leaderboard_payload);
    return { id: row.id, requestId: row.id, leaseToken: row.lease_token, guildId: row.guild_id,
      categoryId: row.category_id, channelId: row.chat_channel_id, creatorDiscordUserId: row.creator_discord_user_id,
      creator: { userId: row.creator_user_id, username: null },
      kind: row.request_kind,
      deal: deal ? { ...deal, conversionRatePercent: deal.conversion_rate_bps / 100 } : null,
      multiplier,
      pnl,
      rewards: rewards
        ? deal
          ? { ...rewards, accrualStartAt: deal.week_start_utc, endsAt: deal.week_end_utc }
          // `execute` bypasses the column's string mode, so normalize the
          // timestamptz the driver hands back before it reaches the bot.
          : { ...rewards, accrualStartAt: new Date(row.window_start_at).toISOString(), endsAt: new Date(row.window_end_at).toISOString() }
        : null,
      leaderboard,
      terms: { version: row.agreement_version, lines: z.array(z.string()).parse(row.agreement_lines) },
      attempt: row.delivery_attempt_count, previousMessageId: row.summary_message_id };
  });
}

export async function acknowledgeCreatorDealApprovalJob(input: {
  id: string; guildId: string; leaseToken: string; status: "delivered" | "failed";
  discordMessageId?: string; errorCode?: string; errorMessage?: string;
}): Promise<{ status: "awaiting_continue" | "awaiting_decision" | "pending_delivery" | "delivery_failed" }> {
  const id = Uuid.parse(input.id); const guildId = DiscordId.parse(input.guildId); const lease = Uuid.parse(input.leaseToken);
  if (input.status === "delivered") {
    const messageId = DiscordId.parse(input.discordMessageId);
    const result = await adminDrizzle.transaction(async (tx) => {
      // Both deal proposals have terms to present, so both park in
      // `awaiting_continue`. A standalone leaderboard or reward program lands
      // straight on Approve/Decline.
      const updated = await tx.execute<{ status: "awaiting_continue" | "awaiting_decision" }>(sql`
        UPDATE creator_deal_approval_requests
        SET status = CASE WHEN request_kind IN ('deal', 'multiplier_deal', 'pnl_deal') THEN 'awaiting_continue' ELSE 'awaiting_decision' END,
          summary_message_id = ${messageId},
          delivery_lease_token = NULL, delivery_lease_owner = NULL, delivery_leased_until = NULL,
          last_error_step = NULL, last_error_code = NULL, last_error_message = NULL, updated_at = now()
        WHERE id = ${id}::uuid AND guild_id = ${guildId} AND delivery_lease_token = ${lease}::uuid
          AND status = 'pending_delivery' RETURNING status
      `);
      if (!updated.rows[0]) {
        const [already] = await tx.select({ status: creator_deal_approval_requests.status, summaryMessageId: creator_deal_approval_requests.summary_message_id })
          .from(creator_deal_approval_requests).where(and(eq(creator_deal_approval_requests.id, id), eq(creator_deal_approval_requests.guild_id, guildId))).limit(1);
        if ((already?.status === "awaiting_continue" || already?.status === "awaiting_decision") && already.summaryMessageId === messageId) {
          return { status: already.status as "awaiting_continue" | "awaiting_decision" };
        }
        error(409, "delivery_lease_lost", "Delivery lease is no longer active.");
      }
      await tx.insert(creator_deal_approval_events).values({ request_id: id, event_type: "summary_delivered", actor_kind: "bot", metadata: { discordMessageId: messageId, status: updated.rows[0].status } });
      return { status: updated.rows[0].status };
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

function markerDeal(deal: CreatorDealResponse, requestId: string, periodIndex?: number): boolean {
  const terms = deal.terms;
  if (!terms || typeof terms !== "object") return false;
  const record = terms as Record<string, unknown>;
  if (record.creator_approval_request_id !== requestId) return false;
  return periodIndex === undefined
    || Number(record.creator_approval_period_index ?? 0) === periodIndex;
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
  /** The request's declared window start — a prior program that ended exactly
   *  here is the only continuation candidate. Not the same as `windowStart`,
   *  which is clamped forward to the approval time. */
  priorEndsAt: string;
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
        AND ends_at = ${input.priorEndsAt}::timestamptz
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
        priorDealEndedAt: input.priorEndsAt,
        nextDealEndsAt: input.windowEnd.toISOString(),
      },
    });
    return prior.id;
  });
}

function dealWindowsOverlap(
  existing: Pick<CreatorDealResponse, "week_start_utc" | "week_end_utc">,
  proposed: { week_start_utc: string; week_end_utc: string },
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
    const periods = buildBackendDealPeriods(payload);
    const listed = await listAllCreatorDeals(request.creator_user_id);
    const existingPeriods = periods.map((period) =>
      listed.find((deal) =>
        (deal.status === "scheduled" || deal.status === "active")
        && markerDeal(deal, request.id, period.index)),
    );
    if (existingPeriods.every(Boolean)) {
      return { ok: true, dealId: existingPeriods[0]!.id };
    }
    const overlap = listed.find((deal) =>
      (deal.status === "active" || deal.status === "scheduled")
      && !markerDeal(deal, request.id)
      && periods.some((period) => dealWindowsOverlap(deal, period.payload)));
    if (overlap) {
      error(
        409,
        "creator_deal_window_overlap",
        `Creator already has an ${overlap.status} deal during the proposed window.`,
      );
    }
    if (periods.length === 1 && request.backend_create_attempted_at) {
      error(409, "backend_create_unconfirmed", "The original backend create attempt is not visible yet. It will not be repeated because its outcome may be ambiguous.");
    }
    if (!request.backend_create_attempted_at) {
      const [claimed] = await tx.update(creator_deal_approval_requests).set({
        backend_create_attempted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).where(and(
        eq(creator_deal_approval_requests.id, request.id),
        sql`${creator_deal_approval_requests.backend_create_attempted_at} IS NULL`,
      )).returning({ id: creator_deal_approval_requests.id });
      if (!claimed) error(409, "backend_create_in_progress", "Another worker already started backend deal creation.");
    }
    try {
      const dealIds: string[] = [];
      for (const period of periods) {
        const existing = existingPeriods[period.index];
        if (existing) {
          dealIds.push(existing.id);
          continue;
        }
        const created = await creatorsApi.createDeal(request.creator_user_id, {
          ...period.payload,
          terms: {
            creator_approval_request_id: request.id,
            creator_approval_period_index: period.index,
            creator_approval_period_count: period.count,
            agreement_version: request.agreement_version,
            agreement_checksum: request.agreement_checksum,
          },
        } satisfies CreateDealInput);
        dealIds.push(created.id);
      }
      return { ok: true, dealId: dealIds[0] };
    } catch (cause) {
      // Resolve an ambiguous response before compensating. A complete marked
      // schedule is success even when the final HTTP response was lost.
      const afterFailure = await listAllCreatorDeals(request.creator_user_id);
      const reconciled = periods.map((period) => afterFailure.find((deal) =>
        (deal.status === "scheduled" || deal.status === "active")
        && markerDeal(deal, request.id, period.index)));
      if (reconciled.every(Boolean)) {
        return { ok: true, dealId: reconciled[0]!.id };
      }
      // MAIN has no batch-create endpoint. Compensate a partially provisioned
      // schedule immediately so no subset can remain financially active if a
      // foreign caller interleaves between period creates. A later retry then
      // starts clean or reports the foreign overlap.
      const partial = afterFailure.filter((deal) =>
        (deal.status === "scheduled" || deal.status === "active")
        && markerDeal(deal, request.id));
      for (const deal of partial) {
        await creatorsApi.terminateDeal(request.creator_user_id, deal.id, {
          reason: `Compensating incomplete approval schedule ${request.id}`,
          force_end_active_session: true,
        });
      }
      return { ok: false, cause };
    }
  });
  if (!outcome.ok) throw outcome.cause;
  return outcome.dealId;
}

function multiplierApprovalMarker(request: typeof creator_deal_approval_requests.$inferSelect): string {
  return `approval-${request.agreement_version}-${request.id}`;
}

async function listAllMultiplierDeals(creatorUserId: string): Promise<MultiplierDealResponse[]> {
  const deals: MultiplierDealResponse[] = [];
  const limit = 100;
  for (let offset = 0; ;) {
    const page = await multiplierDealsApi.list(creatorUserId, { offset, limit });
    deals.push(...page.data);
    if (deals.length >= page.total) return deals;
    if (page.data.length === 0) error(409, "multiplier_deal_history_incomplete", "Multiplier deal history could not be fully verified.");
    offset += page.data.length;
    if (offset >= 10_000) error(409, "multiplier_deal_history_too_large", "Multiplier deal history is too large to verify safely.");
  }
}

async function ensureBackendMultiplierDeal(request: typeof creator_deal_approval_requests.$inferSelect): Promise<string> {
  if (request.backend_deal_id) return request.backend_deal_id;
  const outcome = await adminDrizzle.transaction(async (tx): Promise<
    { ok: true; dealId: string } | { ok: false; cause: unknown }
  > => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`creator-multiplier-deal:${request.creator_user_id}`}, 0))`);
    const payload = MultiplierPayloadSchema.parse(request.multiplier_payload);
    const marker = multiplierApprovalMarker(request);
    const listed = await listAllMultiplierDeals(request.creator_user_id);
    const existing = listed.find((deal) => deal.terms_version === marker);
    if (existing) return { ok: true, dealId: existing.id };
    const conflicting = listed.find((deal) =>
      ["pending_deposit", "funded", "live", "pending_review", "flagged"].includes(deal.status));
    if (conflicting) {
      error(409, "multiplier_deal_conflict", `Creator already has a ${conflicting.status.replaceAll("_", " ")} multiplier deal.`);
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
    if (!claimed) error(409, "backend_create_in_progress", "Another worker already started multiplier deal creation.");
    const { approval_expires_at: _approvalExpiresAt, ...contract } = payload;
    try {
      const created = await multiplierDealsApi.create(request.creator_user_id, {
        ...contract,
        terms_text: z.array(z.string()).parse(request.agreement_lines).join("\n"),
        terms_version: marker,
      } satisfies CreateMultiplierDealInput);
      return { ok: true, dealId: created.id };
    } catch (cause) {
      return { ok: false, cause };
    }
  });
  if (!outcome.ok) throw outcome.cause;
  return outcome.dealId;
}

// ADMIN owns the commercial P&L contract. The customer backend only owns the
// ordinary fill or multiplier record used to fund it.
type PnlFundingProvision = {
  linkedFillDealId: string | null;
  linkedMultiplierDealId: string | null;
  linkedBackendDealId: string;
  multiplierTermsSnapshot: PnlMultiplierFundingSnapshot | null;
};

function pnlMultiplierApprovalMarker(
  request: typeof creator_deal_approval_requests.$inferSelect,
): string {
  return `pnl-approval-${request.agreement_version}-${request.id}`;
}

async function ensurePnlFunding(
  request: typeof creator_deal_approval_requests.$inferSelect,
  payload: z.infer<typeof PnlPayloadSchema>,
  markCreateAttempted: () => Promise<void>,
): Promise<PnlFundingProvision> {
  if (payload.funding.type === "linked_multiplier") {
    const linked = await multiplierDealsApi.get(
      request.creator_user_id,
      payload.funding.multiplier_deal_id,
    );
    if (linked.multiplier_bps < 20_000) {
      error(409, "linked_multiplier_below_minimum", "The linked multiplier must be at least 2x for P&L funding.");
    }
    if (!["pending_deposit", "funded", "live"].includes(linked.status)) {
      error(409, "linked_multiplier_unavailable", `The linked multiplier is ${linked.status.replaceAll("_", " ")} and cannot fund a new P&L frame.`);
    }
    if (linked.auto_end_at && new Date(linked.auto_end_at) < new Date(payload.frame_end_utc)) {
      error(409, "linked_multiplier_frame_too_short", "The linked multiplier ends before the proposed P&L frame.");
    }
    return {
      linkedFillDealId: null,
      linkedMultiplierDealId: linked.id,
      linkedBackendDealId: linked.id,
      multiplierTermsSnapshot: snapshotPnlMultiplierFunding(linked),
    };
  }

  if (payload.funding.type === "new_multiplier") {
    const marker = pnlMultiplierApprovalMarker(request);
    const listed = await listAllMultiplierDeals(request.creator_user_id);
    const existing = listed.find((deal) => deal.terms_version === marker);
    if (existing) {
      if (!["pending_deposit", "funded", "live"].includes(existing.status)) {
        error(409, "pnl_multiplier_funding_unavailable", `The previously created multiplier funding is ${existing.status.replaceAll("_", " ")}.`);
      }
      return {
        linkedFillDealId: null,
        linkedMultiplierDealId: existing.id,
        linkedBackendDealId: existing.id,
        multiplierTermsSnapshot: snapshotPnlMultiplierFunding(existing),
      };
    }
    const conflicting = listed.find((deal) =>
      ["pending_deposit", "funded", "live", "pending_review", "flagged"].includes(deal.status));
    if (conflicting) {
      error(409, "multiplier_deal_conflict", `Creator already has a ${conflicting.status.replaceAll("_", " ")} multiplier deal.`);
    }
    await markCreateAttempted();
    const created = await multiplierDealsApi.create(request.creator_user_id, {
      required_deposit_usd: payload.funding.required_deposit_usd,
      multiplier_bps: payload.funding.multiplier_bps,
      withdrawable_bps: payload.funding.withdrawable_bps,
      wager_requirement_bps: payload.funding.wager_requirement_bps,
      max_total_wager_usd: payload.funding.max_total_wager_usd,
      max_payout_usd: payload.funding.max_payout_usd,
      min_session_duration_seconds: payload.funding.min_session_duration_seconds,
      min_bet_count: payload.funding.min_bet_count,
      min_wager_to_funding_ratio_bps: payload.funding.min_wager_to_funding_ratio_bps,
      kick_vod_required: payload.funding.kick_vod_required,
      auto_renew: false,
      terms_text: z.array(z.string()).parse(request.agreement_lines).join("\n"),
      terms_version: marker,
    } satisfies CreateMultiplierDealInput);
    return {
      linkedFillDealId: null,
      linkedMultiplierDealId: created.id,
      linkedBackendDealId: created.id,
      multiplierTermsSnapshot: snapshotPnlMultiplierFunding(created),
    };
  }

  const listed = await listAllCreatorDeals(request.creator_user_id);
  const existing = listed.find((deal) => markerDeal(deal, request.id));
  if (existing) {
    if (existing.status !== "scheduled" && existing.status !== "active") {
      error(409, "pnl_fill_funding_unavailable", `The previously created fill funding is ${existing.status}.`);
    }
    return {
      linkedFillDealId: existing.id,
      linkedMultiplierDealId: null,
      linkedBackendDealId: existing.id,
      multiplierTermsSnapshot: null,
    };
  }
  const proposed = {
    week_start_utc: payload.frame_start_utc,
    week_end_utc: payload.frame_end_utc,
  } as z.infer<typeof DealPayloadSchema>;
  const overlap = listed.find((deal) =>
    (deal.status === "active" || deal.status === "scheduled")
    && dealWindowsOverlap(deal, proposed));
  if (overlap) {
    error(409, "creator_deal_window_overlap", `Creator already has an ${overlap.status} fill deal during the proposed P&L frame.`);
  }
  await markCreateAttempted();
  const created = await creatorsApi.createDeal(request.creator_user_id, {
    week_start_utc: payload.frame_start_utc,
    week_end_utc: payload.frame_end_utc,
    fills_allowed: payload.funding.fills_allowed,
    per_fill_amount_usd: payload.funding.per_fill_amount_usd,
    conversion_rate_bps: 0,
    // Conversion is non-withdrawable; leaving the aggregate cap open keeps
    // the separately approved tip/sponsorship allowances usable.
    total_withdraw_cap_usd: null,
    cooldown_minutes: payload.funding.cooldown_minutes,
    max_tip_per_stream_usd: payload.max_tip_per_stream_usd ?? 0,
    max_tip_per_user_usd: payload.max_tip_per_user_usd ?? 0,
    max_sponsored_battle_usd: payload.max_sponsored_battle_usd ?? 0,
    max_sponsorship_per_stream_usd: payload.max_sponsorship_per_stream_usd ?? 0,
    allow_site_leaderboards: false,
    allow_code_leaderboards: false,
    terms: {
      creator_approval_request_id: request.id,
      pnl_funding_only: true,
      agreement_version: request.agreement_version,
      agreement_checksum: request.agreement_checksum,
    },
  } satisfies CreateDealInput);
  return {
    linkedFillDealId: created.id,
    linkedMultiplierDealId: null,
    linkedBackendDealId: created.id,
    multiplierTermsSnapshot: null,
  };
}

async function ensureAdminPnlDeal(
  request: typeof creator_deal_approval_requests.$inferSelect,
): Promise<{ pnlDealId: string; linkedBackendDealId: string }> {
  if (request.pnl_deal_id) {
    const [existing] = await adminDrizzle.select({
      id: creator_pnl_deals.id,
      linkedFillDealId: creator_pnl_deals.linked_fill_deal_id,
      linkedMultiplierDealId: creator_pnl_deals.linked_multiplier_deal_id,
    }).from(creator_pnl_deals).where(eq(creator_pnl_deals.id, request.pnl_deal_id)).limit(1);
    if (!existing) error(409, "admin_pnl_deal_missing", "The approval references a missing Admin P&L deal.");
    return {
      pnlDealId: existing.id,
      linkedBackendDealId: existing.linkedFillDealId ?? existing.linkedMultiplierDealId
        ?? error(409, "admin_pnl_funding_missing", "The Admin P&L deal has no linked funding record."),
    };
  }

  const outcome = await adminDrizzle.transaction(async (tx): Promise<
    { ok: true; pnlDealId: string; linkedBackendDealId: string } | { ok: false; cause: unknown }
  > => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`creator-pnl-deal:${request.creator_user_id}`}, 0))`);
    const [existing] = await tx.select({
      id: creator_pnl_deals.id,
      linkedFillDealId: creator_pnl_deals.linked_fill_deal_id,
      linkedMultiplierDealId: creator_pnl_deals.linked_multiplier_deal_id,
    }).from(creator_pnl_deals)
      .where(eq(creator_pnl_deals.source_approval_request_id, request.id))
      .limit(1);
    if (existing) {
      return {
        ok: true,
        pnlDealId: existing.id,
        linkedBackendDealId: existing.linkedFillDealId ?? existing.linkedMultiplierDealId
          ?? error(409, "admin_pnl_funding_missing", "The Admin P&L deal has no linked funding record."),
      };
    }

    const payload = PnlPayloadSchema.parse(request.pnl_payload);
    const [conflict] = await tx.select({ id: creator_pnl_deals.id, status: creator_pnl_deals.status })
      .from(creator_pnl_deals)
      .where(and(
        eq(creator_pnl_deals.creator_user_id, request.creator_user_id),
        sql`${creator_pnl_deals.status} IN ('scheduled','active','settlement_pending','calculated','crediting')`,
        sql`${creator_pnl_deals.frame_start_utc} < ${payload.frame_end_utc}::timestamptz`,
        sql`${creator_pnl_deals.frame_end_utc} > ${payload.frame_start_utc}::timestamptz`,
      )).limit(1);
    if (conflict) {
      error(409, "pnl_deal_window_overlap", `Creator already has a ${conflict.status.replaceAll("_", " ")} Admin P&L deal during the proposed frame.`);
    }

    let attempted = request.backend_create_attempted_at != null;
    const markCreateAttempted = async () => {
      if (attempted) {
        error(409, "backend_create_unconfirmed", "The original funding create attempt is not visible yet. It will not be repeated because its outcome may be ambiguous.");
      }
      const [claimed] = await tx.update(creator_deal_approval_requests).set({
        backend_create_attempted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).where(and(
        eq(creator_deal_approval_requests.id, request.id),
        sql`${creator_deal_approval_requests.backend_create_attempted_at} IS NULL`,
      )).returning({ id: creator_deal_approval_requests.id });
      if (!claimed) error(409, "backend_create_in_progress", "Another worker already started P&L funding creation.");
      attempted = true;
    };

    try {
      const funding = await ensurePnlFunding(request, payload, markCreateAttempted);
      const pnlDealId = crypto.randomUUID();
      const now = new Date();
      const startsActive = new Date(payload.frame_start_utc) <= now;
      await tx.insert(creator_pnl_deals).values({
        id: pnlDealId,
        creator_user_id: request.creator_user_id,
        source_approval_request_id: request.id,
        status: startsActive ? "active" : "scheduled",
        frame_start_utc: payload.frame_start_utc,
        frame_end_utc: payload.frame_end_utc,
        positive_pnl_share_bps: payload.positive_pnl_share_bps,
        funding_mode: payload.funding.type,
        funding_config: funding.multiplierTermsSnapshot
          ? {
              ...payload.funding,
              multiplier_terms_snapshot: funding.multiplierTermsSnapshot,
            }
          : payload.funding,
        linked_fill_deal_id: funding.linkedFillDealId,
        linked_multiplier_deal_id: funding.linkedMultiplierDealId,
        max_tip_per_stream_usd: payload.max_tip_per_stream_usd == null ? null : String(payload.max_tip_per_stream_usd),
        max_tip_per_user_usd: payload.max_tip_per_user_usd == null ? null : String(payload.max_tip_per_user_usd),
        max_sponsored_battle_usd: payload.max_sponsored_battle_usd == null ? null : String(payload.max_sponsored_battle_usd),
        max_sponsorship_per_stream_usd: payload.max_sponsorship_per_stream_usd == null ? null : String(payload.max_sponsorship_per_stream_usd),
        terms_snapshot: {
          agreement_document_id: request.agreement_document_id,
          agreement_version: request.agreement_version,
          agreement_checksum: request.agreement_checksum,
          agreement_lines: z.array(z.string()).parse(request.agreement_lines),
        },
        credit_idempotency_key: `creator-pnl:${pnlDealId}`,
        activated_at: startsActive ? now.toISOString() : null,
        created_by_admin_user_id: request.submitted_by,
      });
      await tx.update(creator_deal_approval_requests).set({
        pnl_deal_id: pnlDealId,
        backend_deal_id: funding.linkedBackendDealId,
        updated_at: now.toISOString(),
      }).where(eq(creator_deal_approval_requests.id, request.id));
      return { ok: true, pnlDealId, linkedBackendDealId: funding.linkedBackendDealId };
    } catch (cause) {
      // Commit an ambiguous remote-create marker. A retry first reconciles the
      // ordinary fill/multiplier by its immutable terms marker.
      return { ok: false, cause };
    }
  });
  if (!outcome.ok) throw outcome.cause;
  return { pnlDealId: outcome.pnlDealId, linkedBackendDealId: outcome.linkedBackendDealId };
}

/**
 * Materialize time-derived activation and calculation readiness before an
 * Admin P&L list, calculation, or credit action reads lifecycle state.
 */
export async function advanceDueCreatorPnlDeals(now = new Date()): Promise<{
  activated: number;
  readyForCalculation: number;
}> {
  return adminDrizzle.transaction(async (tx) => {
    const timestamp = now.toISOString();
    const activated = await tx.update(creator_pnl_deals).set({
      status: "active",
      activated_at: timestamp,
      updated_at: timestamp,
      version: sql`${creator_pnl_deals.version} + 1`,
    }).where(and(
      eq(creator_pnl_deals.status, "scheduled"),
      sql`${creator_pnl_deals.frame_start_utc} <= ${timestamp}::timestamptz`,
      sql`${creator_pnl_deals.frame_end_utc} > ${timestamp}::timestamptz`,
    )).returning({ id: creator_pnl_deals.id });
    const ready = await tx.update(creator_pnl_deals).set({
      status: "settlement_pending",
      updated_at: timestamp,
      version: sql`${creator_pnl_deals.version} + 1`,
    }).where(and(
      sql`${creator_pnl_deals.status} IN ('scheduled','active')`,
      sql`${creator_pnl_deals.frame_end_utc} <= ${timestamp}::timestamptz`,
    )).returning({ id: creator_pnl_deals.id });
    return { activated: activated.length, readyForCalculation: ready.length };
  });
}

async function ensureRewardProgram(request: typeof creator_deal_approval_requests.$inferSelect, approvedAt: Date): Promise<string | null> {
  if (!request.reward_payload) return null;
  if (request.reward_program_id) return request.reward_program_id;
  const reward = RewardPayloadSchema.parse(request.reward_payload);
  const codes = await validateCreatorAndCodes(request.creator_user_id, reward.codes);
  const windowStartIso = new Date(request.window_start_at).toISOString();
  const start = new Date(Math.max(new Date(request.window_start_at).getTime(), approvedAt.getTime()));
  // Re-derive from the request's canonical window as a fail-closed guard for
  // proposals written before `reward_payload.endsAt` became mandatory, and so
  // a deal-less rewards request works with no deal snapshot at all.
  const end = new Date(request.window_end_at);
  if (end <= start) error(409, "reward_window_elapsed", "The reward program would end before it can begin.");
  const continuedProgramId = await continueAdjacentRewardProgram({
    request,
    reward,
    priorEndsAt: windowStartIso,
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

async function findProvisionedLeaderboard(
  request: typeof creator_deal_approval_requests.$inferSelect,
): Promise<string | null> {
  if (!request.leaderboard_payload) return null;
  const board = LeaderboardPayloadSchema.parse(request.leaderboard_payload);
  const codes = await validateCreatorAndCodes(request.creator_user_id, board.codes);
  const rows = [];
  let offset = 0;
  do {
    const page = await affiliateLeaderboardsApi.list({
      status: "approved",
      creator_user_id: request.creator_user_id,
      include_cancelled: false,
      offset,
      limit: 100,
    });
    rows.push(...page.leaderboards);
    offset += page.leaderboards.length;
    if (offset >= page.total || page.leaderboards.length === 0) break;
  } while (true);
  const matches = matchingApprovedLeaderboards(rows, {
    creatorUserId: request.creator_user_id,
    approvedBy: request.submitted_by,
    title: board.title,
    codes,
    siteBonusUsd: board.siteBonusUsd,
    startsAt: board.startsAt,
    endsAt: board.endsAt,
    prizeTiers: board.prizeTiers,
  });
  if (matches.length > 1) {
    error(409, "leaderboard_reconciliation_ambiguous", "Multiple existing leaderboards match this approval.");
  }
  return matches[0]?.id ?? null;
}

async function bindProvisionedLeaderboard(
  request: typeof creator_deal_approval_requests.$inferSelect,
  leaderboardId: string,
  recovered: boolean,
): Promise<void> {
  const board = LeaderboardPayloadSchema.parse(request.leaderboard_payload);
  await adminDrizzle.transaction(async (tx) => {
    await tx.update(creator_deal_approval_requests).set({
      leaderboard_id: leaderboardId,
      updated_at: new Date().toISOString(),
    }).where(eq(creator_deal_approval_requests.id, request.id));
    await tx.insert(admin_leaderboard_sponsorship).values({
        leaderboard_id: leaderboardId,
        sponsored_percentage: String(board.sponsoredPct),
        set_by_admin_id: request.submitted_by,
      }).onConflictDoUpdate({
        target: admin_leaderboard_sponsorship.leaderboard_id,
        set: {
          sponsored_percentage: String(board.sponsoredPct),
          set_by_admin_id: request.submitted_by,
          updated_at: new Date().toISOString(),
        },
      });
    await tx.insert(creator_deal_approval_events).values({
      request_id: request.id,
      event_type: recovered ? "leaderboard_reconciled" : "leaderboard_provisioned",
      actor_kind: "system",
      metadata: { leaderboardId, recovered, sponsoredPct: board.sponsoredPct, siteBonusUsd: board.siteBonusUsd },
    });
  });
}

/** Reconcile an ambiguous prior create before ever creating another board. */
async function ensureLeaderboard(request: typeof creator_deal_approval_requests.$inferSelect): Promise<string | null> {
  if (!request.leaderboard_payload) return null;
  if (request.leaderboard_id) return request.leaderboard_id;
  const recoveredId = await findProvisionedLeaderboard(request);
  if (recoveredId) {
    await bindProvisionedLeaderboard(request, recoveredId, true);
    return recoveredId;
  }
  const board = LeaderboardPayloadSchema.parse(request.leaderboard_payload);
  const codes = await validateCreatorAndCodes(request.creator_user_id, board.codes);
  const created = await affiliateLeaderboardsApi.create({
    creator_user_id: request.creator_user_id,
    co_creator_user_ids: [],
    title: board.title,
    affiliate_codes: codes,
    site_bonus_usd: board.siteBonusUsd,
    start_date: board.startsAt,
    end_date: board.endsAt,
    prize_tiers: board.prizeTiers.map((tier) => ({ position: tier.position, prize_amount_usd: tier.prizeAmountUsd })),
  }, request.submitted_by);
  await bindProvisionedLeaderboard(request, created.id, false);
  return created.id;
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
    const kind = request.request_kind as CreatorApprovalRequestKind;
    const windowEnded = creatorApprovalWindowHasEnded(request.window_end_at);
    // A read-only exact-match recovery is safe after expiry: it binds an asset
    // that MAIN already created and never authorizes a new financial object.
    if (windowEnded && request.leaderboard_payload && !request.leaderboard_id) {
      const recoveredId = await findProvisionedLeaderboard(request);
      if (recoveredId) {
        await bindProvisionedLeaderboard(request, recoveredId, true);
        request.leaderboard_id = recoveredId;
      }
    }
    const allAssetsAlreadyProvisioned = hasAllCreatorApprovalAssets({
      requestKind: kind,
      backendDealId: request.backend_deal_id,
      pnlDealId: request.pnl_deal_id,
      rewardPayloadPresent: request.reward_payload !== null,
      rewardProgramId: request.reward_program_id,
      leaderboardPayloadPresent: request.leaderboard_payload !== null,
      leaderboardId: request.leaderboard_id,
    });
    if (windowEnded && !allAssetsAlreadyProvisioned) {
      error(409, "deal_window_elapsed", "The approved request has already ended.");
    }
    // Fill and ADMIN-owned P&L deals may bundle rewards/leaderboards.
    // Multiplier and standalone requests carry exactly their own payload.
    let backendDealId: string | null = request.backend_deal_id;
    let pnlDealId: string | null = request.pnl_deal_id;
    if (kind === "deal") {
      backendDealId = await ensureBackendDeal(request);
      await adminDrizzle.update(creator_deal_approval_requests).set({ backend_deal_id: backendDealId, updated_at: new Date().toISOString() }).where(and(eq(creator_deal_approval_requests.id, id), eq(creator_deal_approval_requests.provisioning_lease_token, token)));
    } else if (kind === "multiplier_deal") {
      backendDealId = await ensureBackendMultiplierDeal(request);
      await adminDrizzle.update(creator_deal_approval_requests).set({ backend_deal_id: backendDealId, updated_at: new Date().toISOString() }).where(and(eq(creator_deal_approval_requests.id, id), eq(creator_deal_approval_requests.provisioning_lease_token, token)));
    } else if (kind === "pnl_deal") {
      const pnl = await ensureAdminPnlDeal(request);
      pnlDealId = pnl.pnlDealId;
      backendDealId = pnl.linkedBackendDealId;
      await adminDrizzle.update(creator_deal_approval_requests).set({
        pnl_deal_id: pnlDealId,
        backend_deal_id: backendDealId,
        updated_at: new Date().toISOString(),
      }).where(and(eq(creator_deal_approval_requests.id, id), eq(creator_deal_approval_requests.provisioning_lease_token, token)));
    }
    const withDeal = { ...request, backend_deal_id: backendDealId };
    const rewardProgramId = kind === "deal" || kind === "pnl_deal" || kind === "rewards_only" ? await ensureRewardProgram(withDeal, approvedAt) : null;
    const leaderboardId = kind === "deal" || kind === "pnl_deal" || kind === "leaderboard_only" ? await ensureLeaderboard(withDeal) : null;
    await adminDrizzle.transaction(async (tx) => {
      const completed = await tx.execute<{ creator_user_id: string }>(sql`
        UPDATE creator_deal_approval_requests SET status = 'completed', backend_deal_id = ${backendDealId}, pnl_deal_id = ${pnlDealId}::uuid, reward_program_id = ${rewardProgramId}::uuid,
          leaderboard_id = ${leaderboardId}::uuid,
          provisioning_lease_token = NULL, provisioning_leased_until = NULL, last_error_step = NULL,
          last_error_code = NULL, last_error_message = NULL, completed_at = now(), updated_at = now()
        WHERE id = ${id}::uuid AND provisioning_lease_token = ${token}::uuid RETURNING creator_user_id
      `);
      if (!completed.rows[0]) error(409, "provisioning_lease_lost", "Provisioning lease expired.");
      await tx.insert(creator_deal_approval_events).values({ request_id: id, event_type: "provisioned", actor_kind: "system", metadata: { requestKind: kind, backendDealId, pnlDealId, rewardProgramId, leaderboardId } });
      await tx.insert(admin_audit_events).values({ admin_user_id: request.submitted_by, event_type: "creator_deal_approval_provisioned", target_user_id: request.creator_user_id, metadata: { requestId: id, requestKind: kind, backendDealId, pnlDealId, rewardProgramId, leaderboardId } });
    });
    revalidatePath(`/creator-hub/creators/${request.creator_user_id}`);
    revalidatePath("/creator-hub/leaderboards");
    revalidateTag("creator-deal");
    revalidateTag("creator-leaderboards");
    revalidateTag("creators-leaderboard-cost");
    revalidateTag("profitability-past-deals");
    revalidateTag("creator-hub-4w-summary");
    revalidateTag("creator-hub-live-leaderboards");
    return { status: "approved", requestId: id };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Provisioning failed.";
    await adminDrizzle.transaction(async (tx) => {
      const failed = await tx.execute<{ last_error_step: string }>(sql`
        UPDATE creator_deal_approval_requests SET status = 'provisioning_failed', provisioning_lease_token = NULL,
          provisioning_leased_until = NULL, last_error_step = CASE
            WHEN request_kind = 'leaderboard_only' THEN 'leaderboard'
            WHEN request_kind = 'rewards_only' THEN 'reward_program'
            WHEN request_kind = 'multiplier_deal' THEN 'backend_multiplier_deal'
            WHEN request_kind = 'pnl_deal' AND backend_create_attempted_at IS NOT NULL AND pnl_deal_id IS NULL THEN 'backend_pnl_funding'
            WHEN request_kind = 'pnl_deal' AND pnl_deal_id IS NULL THEN 'admin_pnl_deal'
            WHEN backend_deal_id IS NULL THEN 'backend_deal'
            WHEN reward_payload IS NOT NULL AND reward_program_id IS NULL THEN 'reward_program'
            ELSE 'leaderboard' END,
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

    // Canonical for every kind — a standalone leaderboard or reward request
    // has no deal snapshot to read a window from.
    if (
      new Date(request.window_end_at).getTime() <= Date.now()
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
    // Only deal kinds have terms to present. A stray continue on a standalone
    // leaderboard/rewards request is tolerated as a no-op, never as consent.
    if (transition.request_kind !== "deal" && transition.request_kind !== "multiplier_deal" && transition.request_kind !== "pnl_deal") return { status: "awaiting_decision", requestId: parsed.requestId };
    return { status: "awaiting_decision", requestId: parsed.requestId, terms: { version: transition.agreement_version, lines: z.array(z.string()).parse(transition.agreement_lines), checksum: transition.agreement_checksum } };
  }
  if (parsed.action === "decline" || transition.status === "declined") return { status: "declined", requestId: parsed.requestId };
  if (transition.status === "expired") return { status: "expired", requestId: parsed.requestId };
  if (transition.status === "completed") return { status: "approved", requestId: parsed.requestId };
  const provisioned = await provisionApprovedCreatorDealRequest(parsed.requestId);
  return { status: provisioned.status, requestId: parsed.requestId };
}
