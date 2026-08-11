import "server-only";

import { eq, sql } from "drizzle-orm";

import {
  affiliate_codes,
  creator_deals,
} from "@/lib/db-schema/main/schema";
import { getProdReadDrizzleDb } from "@/lib/db";
import { queryCreatorAnalytics } from "@/lib/creator-analytics-db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { toNumber } from "@/lib/utils/decimal";
import { LB_HOUSE_SHARE } from "@/lib/deal-economics";
import {
  affiliateLeaderboardsApi,
  type LeaderboardAdminRow,
} from "@/lib/backend-api/affiliate-leaderboards";
import { getAffiliateLeaderboardPage } from "@/lib/queries/creators-leaderboards";
import {
  CreatorSetupError,
  requireActiveCreator,
  requireLinkedSetupActor,
} from "@/lib/discord-creator-setups";
import { isDiscordDashboardOperator } from "@/lib/discord-dashboard-operators";

const DEAL_LIMIT = 2;
const LEADERBOARD_PAGE_SIZE = 100;
const TOP_ENTRY_LIMIT = 3;

type LastDealStatus = "scheduled" | "active" | "completed" | "terminated";
type LeaderboardTimeStatus = "upcoming" | "active" | "ended";

export type CreatorLastDeals = {
  generatedAt: string;
  creator: {
    userId: string;
    username: string | null;
  };
  deals: Array<{
    dealId: string;
    status: LastDealStatus;
    startedAt: string;
    endedAt: string;
    signups: number;
    firstTimeDepositors: number;
    depositsUsd: number;
    weightedWagerUsd: number;
    support: {
      fillCount: number;
      fillsLoadedUsd: number;
      fillsSpentUsd: number;
      fillsRefundedUsd: number;
      fillsRemainingUsd: number;
      convertedPayoutUsd: number;
      tipsUsd: number;
      sponsoredBattlesUsd: number;
    };
    terms: {
      weeks: Array<{
        fillAmountUsd: number;
        keepPercentage: number;
        withdrawalCap7DayUsd: number | null;
      }>;
      tipAllowancesPerStreamUsd: number[];
      tipAllowancesPerUserUsd: number[];
      sponsorshipAllowancesPerStreamUsd: number[];
      sponsorshipAllowancesPerBattleUsd: number[];
    };
    leaderboards: Array<{
      leaderboardId: string;
      title: string;
      status: LeaderboardTimeStatus;
      startedAt: string;
      endedAt: string;
      totalPrizeUsd: number;
      totalEntries: number;
      weightedWagerUsd: number;
      packyPaidPercentage: number;
      topEntries: Array<{
        rank: number;
        username: string;
        wagerUsd: number;
        prizeUsd: number | null;
      }>;
    }>;
  }>;
};

type DealRow = {
  id: string;
  status: LastDealStatus;
  week_start_utc: string;
  week_end_utc: string;
  per_fill_amount_usd: string;
  conversion_rate_bps: number;
  max_tip_per_stream_usd: string;
  max_tip_per_user_usd: string;
  max_sponsored_battle_usd: string;
  max_sponsorship_per_stream_usd: string;
  total_withdraw_cap_usd: string | null;
};

type DealMetricsRow = {
  deal_id: string;
  signups: string;
  first_time_depositors: string;
  deposits_usd: string;
  fill_count: string;
  fills_loaded_usd: string;
  fills_spent_usd: string;
  fills_refunded_usd: string;
  fills_remaining_usd: string;
  converted_payout_usd: string;
  tips_usd: string;
  sponsored_battles_usd: string;
};

const money = (value: unknown): number =>
  Math.round(toNumber(value) * 100) / 100;

const uniqueNumbers = (values: number[]): number[] =>
  Array.from(new Set(values.filter(Number.isFinite))).sort((a, b) => a - b);

function overlaps(
  leftStart: string,
  leftEnd: string,
  rightStart: string,
  rightEnd: string,
): boolean {
  return (
    Math.min(Date.parse(leftEnd), Date.parse(rightEnd)) >
    Math.max(Date.parse(leftStart), Date.parse(rightStart))
  );
}

async function listApprovedCreatorLeaderboards(
  creatorUserId: string,
): Promise<LeaderboardAdminRow[]> {
  const first = await affiliateLeaderboardsApi.list({
    status: "approved",
    creator_user_id: creatorUserId,
    include_cancelled: false,
    limit: LEADERBOARD_PAGE_SIZE,
    offset: 0,
  });
  const pages = [first.leaderboards];
  const requests: Array<ReturnType<typeof affiliateLeaderboardsApi.list>> = [];
  for (
    let offset = LEADERBOARD_PAGE_SIZE;
    offset < first.total;
    offset += LEADERBOARD_PAGE_SIZE
  ) {
    requests.push(
      affiliateLeaderboardsApi.list({
        status: "approved",
        creator_user_id: creatorUserId,
        include_cancelled: false,
        limit: LEADERBOARD_PAGE_SIZE,
        offset,
      }),
    );
  }
  for (const page of await Promise.all(requests)) pages.push(page.leaderboards);
  return pages.flat();
}

/**
 * Creator/admin view of the latest two started creator deal frames.
 *
 * The leaderboard frame is the deal: a bi-weekly leaderboard spans two weekly
 * fill-program records and must produce one 14-day result. Every performance
 * and support metric is bounded to that frame, never to one arbitrary weekly
 * record that happens to overlap it.
 */
export async function getCreatorLastDeals(input: {
  guildId: string;
  categoryId: string;
  channelId: string;
  actorDiscordUserId: string;
}): Promise<CreatorLastDeals> {
  const setup = await requireLinkedSetupActor(input, {
    allowDashboardOperator: true,
  });
  if (
    input.actorDiscordUserId !== setup.creator_discord_user_id &&
    !isDiscordDashboardOperator(input.actorDiscordUserId)
  ) {
    throw new CreatorSetupError(
      403,
      "setup_actor_forbidden",
      "Only this creator or an authorized dashboard operator can view deal performance.",
    );
  }

  const db = getProdReadDrizzleDb();
  const [creator, ownedCodes, excludedUserIds, allLeaderboards] = await Promise.all([
    requireActiveCreator(setup.creator_user_id),
    db
      .select({ code: affiliate_codes.code })
      .from(affiliate_codes)
      .where(eq(affiliate_codes.user_id, setup.creator_user_id)),
    getExcludedUserIds(),
    listApprovedCreatorLeaderboards(setup.creator_user_id),
  ]);
  const now = Date.now();
  const frames = allLeaderboards
    .filter((leaderboard) => Date.parse(leaderboard.start_date) <= now)
    .sort((a, b) => b.start_date.localeCompare(a.start_date))
    .slice(0, DEAL_LIMIT);
  if (frames.length === 0) {
    return {
      generatedAt: new Date().toISOString(),
      creator: { userId: creator.id, username: creator.username },
      deals: [],
    };
  }

  const codes = Array.from(
    new Set(
      ownedCodes
        .map((row) => row.code.trim().toUpperCase())
        .filter(Boolean),
    ),
  );
  const dealWindows = frames.map((frame) => ({
    id: frame.id,
    start_at: new Date(frame.start_date).toISOString(),
    end_at: new Date(frame.end_date).toISOString(),
    codes: Array.from(
      new Set(
        (frame.affiliate_codes.length > 0 ? frame.affiliate_codes : codes)
          .map((code) => code.trim().toUpperCase())
          .filter(Boolean),
      ),
    ),
  }));
  const earliestStart = dealWindows.reduce(
    (earliest, frame) => frame.start_at < earliest ? frame.start_at : earliest,
    dealWindows[0].start_at,
  );
  const latestEnd = dealWindows.reduce(
    (latest, frame) => frame.end_at > latest ? frame.end_at : latest,
    dealWindows[0].end_at,
  );
  const weeklyDeals = await db
    .select({
      id: creator_deals.id,
      status: creator_deals.status,
      week_start_utc: creator_deals.week_start_utc,
      week_end_utc: creator_deals.week_end_utc,
      per_fill_amount_usd: creator_deals.per_fill_amount_usd,
      conversion_rate_bps: creator_deals.conversion_rate_bps,
      max_tip_per_stream_usd: creator_deals.max_tip_per_stream_usd,
      max_tip_per_user_usd: creator_deals.max_tip_per_user_usd,
      max_sponsored_battle_usd: creator_deals.max_sponsored_battle_usd,
      max_sponsorship_per_stream_usd: creator_deals.max_sponsorship_per_stream_usd,
      total_withdraw_cap_usd: creator_deals.total_withdraw_cap_usd,
    })
    .from(creator_deals)
    .where(sql`${creator_deals.user_id} = ${setup.creator_user_id}
      AND ${creator_deals.week_start_utc} < ${latestEnd}
      AND ${creator_deals.week_end_utc} > ${earliestStart}`) as DealRow[];
  const metricRows = await queryCreatorAnalytics<DealMetricsRow>(`
    WITH deal_windows AS (
      SELECT *
      FROM jsonb_to_recordset($1::jsonb) AS deal(
        id text,
        start_at timestamptz,
        end_at timestamptz,
        codes text[]
      )
    ), activity AS (
      SELECT
        deal.id AS deal_id,
        COUNT(DISTINCT usage.referred_user_id) FILTER (
          WHERE usage.usage_type::text = 'signup'
        )::text AS signups,
        COUNT(DISTINCT usage.referred_user_id) FILTER (
          WHERE usage.usage_type::text = 'deposit'
        )::text AS first_time_depositors
      FROM deal_windows AS deal
      LEFT JOIN affiliate_code_usages AS usage
        ON usage.affiliate_user_id = $2
       AND UPPER(usage.code) = ANY(deal.codes)
       AND usage.status::text = 'completed'
       AND usage.referred_user_id <> usage.affiliate_user_id
       AND usage.created_at >= deal.start_at
       AND usage.created_at < deal.end_at
      LEFT JOIN "user" AS referred ON referred.id = usage.referred_user_id
      WHERE usage.id IS NULL OR (
        referred.role::text NOT IN ('admin', 'support', 'creator')
        AND usage.referred_user_id <> ALL($3::text[])
      )
      GROUP BY deal.id
    ), covered_deposits AS (
      SELECT
        deal.id AS deal_id,
        deposit.id AS deposit_id,
        deposit.amount::numeric AS amount_usd
      FROM deal_windows AS deal
      JOIN ledger_transactions AS deposit
        ON deposit.type = 'deposit'
       AND deposit.status = 'completed'
       AND deposit.amount::numeric > 0
       AND deposit.created_at >= deal.start_at
       AND deposit.created_at < deal.end_at
      JOIN "user" AS referred ON referred.id = deposit.user_id
      JOIN LATERAL (
        SELECT usage.affiliate_user_id AS creator_user_id
        FROM affiliate_code_usages AS usage
        JOIN affiliate_codes AS owned_code
          ON owned_code.user_id = usage.affiliate_user_id
         AND UPPER(owned_code.code) = UPPER(usage.code)
        WHERE usage.referred_user_id = deposit.user_id
          AND usage.referred_user_id <> usage.affiliate_user_id
          AND usage.status::text = 'completed'
          AND UPPER(usage.code) = ANY(deal.codes)
          AND usage.created_at <= deposit.created_at
          AND usage.created_at >= deposit.created_at - INTERVAL '7 days'
        ORDER BY usage.created_at DESC, usage.id DESC
        LIMIT 1
      ) AS attribution ON attribution.creator_user_id = $2
      WHERE referred.role::text NOT IN ('admin', 'support', 'creator')
        AND deposit.user_id <> ALL($3::text[])
    ), deposits AS (
      SELECT
        deal.id AS deal_id,
        COALESCE(SUM(covered.amount_usd), 0)::text AS deposits_usd
      FROM deal_windows AS deal
      LEFT JOIN covered_deposits AS covered ON covered.deal_id = deal.id
      GROUP BY deal.id
    ), support AS (
      SELECT
        deal.id AS deal_id,
        COUNT(session.id)::text AS fill_count,
        COALESCE(SUM(session.fill_loaded_usd::numeric), 0)::text AS fills_loaded_usd,
        COALESCE(SUM(session.fill_spent_usd::numeric), 0)::text AS fills_spent_usd,
        COALESCE(SUM(session.fill_refunded_usd::numeric), 0)::text AS fills_refunded_usd,
        COALESCE(SUM(session.fill_remaining_usd::numeric), 0)::text AS fills_remaining_usd,
        COALESCE(SUM(session.converted_to_raw_usd::numeric), 0)::text AS converted_payout_usd,
        COALESCE(SUM(session.tips_spent_this_session_usd::numeric), 0)::text AS tips_usd,
        COALESCE(SUM(session.sponsorship_spent_this_session_usd::numeric), 0)::text
          AS sponsored_battles_usd
      FROM deal_windows AS deal
      LEFT JOIN creator_stream_sessions AS session
        ON session.user_id = $2
       AND session.activated_at >= deal.start_at
       AND session.activated_at < deal.end_at
      GROUP BY deal.id
    )
    SELECT
      deal.id AS deal_id,
      activity.signups,
      activity.first_time_depositors,
      deposits.deposits_usd,
      support.fill_count,
      support.fills_loaded_usd,
      support.fills_spent_usd,
      support.fills_refunded_usd,
      support.fills_remaining_usd,
      support.converted_payout_usd,
      support.tips_usd,
      support.sponsored_battles_usd
    FROM deal_windows AS deal
    JOIN activity ON activity.deal_id = deal.id
    JOIN deposits ON deposits.deal_id = deal.id
    JOIN support ON support.deal_id = deal.id
  `, [JSON.stringify(dealWindows), setup.creator_user_id, excludedUserIds]);

  const metricsByDeal = new Map(
    metricRows.map((row) => [row.deal_id, row]),
  );

  const dealResults = await Promise.all(
    frames.map(async (frame) => {
      const standings = await getAffiliateLeaderboardPage({
        leaderboardId: frame.id,
        creatorUserId: frame.creator_user_id,
        coCreatorUserIds: frame.co_creator_user_ids,
        affiliateCodes: frame.affiliate_codes,
        startDate: new Date(frame.start_date),
        endDate: new Date(frame.end_date),
        prizeTiers: frame.prize_tiers,
        page: 0,
        pageSize: TOP_ENTRY_LIMIT,
      });
      const leaderboard = {
        leaderboardId: frame.id,
        title: frame.title,
        status: frame.time_status,
        startedAt: new Date(frame.start_date).toISOString(),
        endedAt: new Date(frame.end_date).toISOString(),
        totalPrizeUsd: money(frame.total_prize_usd),
        totalEntries: standings.totalEntries,
        weightedWagerUsd: money(standings.totalWageredUsd),
        packyPaidPercentage: LB_HOUSE_SHARE * 100,
        topEntries: standings.entries.map((entry) => ({
          rank: entry.position,
          username: entry.username?.trim() || "Anonymous player",
          wagerUsd: money(entry.totalWageredUsd),
          prizeUsd: entry.prizeUsd === null ? null : money(entry.prizeUsd),
        })),
      };
      const matchingDeals = weeklyDeals
        .filter((deal) =>
          overlaps(
            deal.week_start_utc,
            deal.week_end_utc,
            frame.start_date,
            frame.end_date,
          ),
        )
        .sort((a, b) => a.week_start_utc.localeCompare(b.week_start_utc));
      const status: LastDealStatus = frame.time_status === "active"
        ? "active"
        : frame.time_status === "upcoming"
          ? "scheduled"
          : matchingDeals.some((deal) => deal.status === "terminated")
            ? "terminated"
            : "completed";
      const metrics = metricsByDeal.get(frame.id);
      return {
        dealId: frame.id,
        status,
        startedAt: leaderboard.startedAt,
        endedAt: leaderboard.endedAt,
        signups: Number(metrics?.signups ?? 0),
        firstTimeDepositors: Number(metrics?.first_time_depositors ?? 0),
        depositsUsd: money(metrics?.deposits_usd ?? 0),
        weightedWagerUsd: leaderboard.weightedWagerUsd,
        support: {
          fillCount: Number(metrics?.fill_count ?? 0),
          fillsLoadedUsd: money(metrics?.fills_loaded_usd ?? 0),
          fillsSpentUsd: money(metrics?.fills_spent_usd ?? 0),
          fillsRefundedUsd: money(metrics?.fills_refunded_usd ?? 0),
          fillsRemainingUsd: money(metrics?.fills_remaining_usd ?? 0),
          convertedPayoutUsd: money(metrics?.converted_payout_usd ?? 0),
          tipsUsd: money(metrics?.tips_usd ?? 0),
          sponsoredBattlesUsd: money(metrics?.sponsored_battles_usd ?? 0),
        },
        terms: {
          weeks: matchingDeals.map((deal) => ({
            fillAmountUsd: money(deal.per_fill_amount_usd),
            keepPercentage: deal.conversion_rate_bps / 100,
            withdrawalCap7DayUsd: deal.total_withdraw_cap_usd === null
              ? null
              : money(deal.total_withdraw_cap_usd),
          })),
          tipAllowancesPerStreamUsd: uniqueNumbers(matchingDeals
            .map((deal) => money(deal.max_tip_per_stream_usd))),
          tipAllowancesPerUserUsd: uniqueNumbers(matchingDeals
            .map((deal) => money(deal.max_tip_per_user_usd))),
          sponsorshipAllowancesPerStreamUsd: uniqueNumbers(matchingDeals
            .map((deal) => money(deal.max_sponsorship_per_stream_usd))),
          sponsorshipAllowancesPerBattleUsd: uniqueNumbers(matchingDeals
            .map((deal) => money(deal.max_sponsored_battle_usd))),
        },
        leaderboards: [leaderboard],
      };
    }),
  );

  return {
    generatedAt: new Date().toISOString(),
    creator: { userId: creator.id, username: creator.username },
    deals: dealResults,
  };
}
