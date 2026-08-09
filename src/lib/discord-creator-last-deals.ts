import "server-only";

import { eq, sql } from "drizzle-orm";

import {
  affiliate_codes,
  creator_deals,
} from "@/lib/db-schema/main/schema";
import { getProdReadDrizzleDb } from "@/lib/db";
import { pgArrayParam } from "@/lib/drizzle-array-param";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { toNumber } from "@/lib/utils/decimal";
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
    leaderboards: Array<{
      leaderboardId: string;
      title: string;
      status: LeaderboardTimeStatus;
      startedAt: string;
      endedAt: string;
      totalPrizeUsd: number;
      totalEntries: number;
      weightedWagerUsd: number;
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
};

type DealActivityRow = {
  deal_id: string;
  signups: string;
  first_time_depositors: string;
  weighted_wager_usd: string;
};

type DealDepositRow = {
  deal_id: string;
  deposits_usd: string;
};

const money = (value: unknown): number =>
  Math.round(toNumber(value) * 100) / 100;

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
 * Creator/admin view of the latest two started creator deals. Every metric is
 * bounded to the deal's half-open `[week_start_utc, week_end_utc)` window.
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
  const [creator, deals, ownedCodes, excludedUserIds] = await Promise.all([
    requireActiveCreator(setup.creator_user_id),
    db
      .select({
        id: creator_deals.id,
        status: creator_deals.status,
        week_start_utc: creator_deals.week_start_utc,
        week_end_utc: creator_deals.week_end_utc,
      })
      .from(creator_deals)
      .where(sql`${creator_deals.user_id} = ${setup.creator_user_id}
        AND ${creator_deals.week_start_utc} <= NOW()`)
      .orderBy(sql`${creator_deals.week_start_utc} DESC`)
      .limit(DEAL_LIMIT),
    db
      .select({ code: affiliate_codes.code })
      .from(affiliate_codes)
      .where(eq(affiliate_codes.user_id, setup.creator_user_id)),
    getExcludedUserIds(),
  ]);
  const typedDeals = deals as DealRow[];
  if (typedDeals.length === 0) {
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
  const dealWindows = typedDeals.map((deal) => ({
    id: deal.id,
    start: new Date(deal.week_start_utc).toISOString(),
    end: new Date(deal.week_end_utc).toISOString(),
  }));
  const excludedUsageFilter =
    excludedUserIds.length > 0
      ? sql`AND usage.referred_user_id <> ALL(${pgArrayParam(excludedUserIds)}::text[])`
      : sql``;
  const excludedDepositFilter =
    excludedUserIds.length > 0
      ? sql`AND deposit.user_id <> ALL(${pgArrayParam(excludedUserIds)}::text[])`
      : sql``;

  const [activityRows, depositRows, allLeaderboards] = await Promise.all([
    codes.length === 0
      ? Promise.resolve({ rows: [] as DealActivityRow[] })
      : db.execute<DealActivityRow>(sql`
          WITH deal_windows AS (
            SELECT *
            FROM jsonb_to_recordset(${JSON.stringify(dealWindows)}::jsonb) AS deal(
              id uuid,
              start_at timestamptz,
              end_at timestamptz
            )
          )
          SELECT
            deal.id::text AS deal_id,
            COUNT(DISTINCT usage.referred_user_id)::text AS signups,
            COUNT(DISTINCT usage.referred_user_id) FILTER (
              WHERE usage.usage_type::text = 'deposit'
            )::text AS first_time_depositors,
            COALESCE(SUM(usage.weighted_wager_amount_usd::numeric), 0)::text
              AS weighted_wager_usd
          FROM deal_windows AS deal
          LEFT JOIN affiliate_code_usages AS usage
            ON usage.affiliate_user_id = ${setup.creator_user_id}
           AND UPPER(usage.code) = ANY(${pgArrayParam(codes)}::text[])
           AND usage.status::text = 'completed'
           AND usage.referred_user_id <> usage.affiliate_user_id
           AND usage.created_at >= deal.start_at
           AND usage.created_at < deal.end_at
          LEFT JOIN "user" AS referred ON referred.id = usage.referred_user_id
          WHERE usage.id IS NULL OR (
            referred.role::text NOT IN ('admin', 'support', 'creator')
            ${excludedUsageFilter}
          )
          GROUP BY deal.id
        `),
    codes.length === 0
      ? Promise.resolve({ rows: [] as DealDepositRow[] })
      : db.execute<DealDepositRow>(sql`
          WITH deal_windows AS (
            SELECT *
            FROM jsonb_to_recordset(${JSON.stringify(dealWindows)}::jsonb) AS deal(
              id uuid,
              start_at timestamptz,
              end_at timestamptz
            )
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
                AND usage.created_at <= deposit.created_at
                AND usage.created_at >= deposit.created_at - INTERVAL '7 days'
              ORDER BY usage.created_at DESC, usage.id DESC
              LIMIT 1
            ) AS attribution ON attribution.creator_user_id = ${setup.creator_user_id}
            WHERE referred.role::text NOT IN ('admin', 'support', 'creator')
              ${excludedDepositFilter}
          )
          SELECT
            deal.id::text AS deal_id,
            COALESCE(SUM(covered.amount_usd), 0)::text AS deposits_usd
          FROM deal_windows AS deal
          LEFT JOIN covered_deposits AS covered ON covered.deal_id = deal.id
          GROUP BY deal.id
        `),
    listApprovedCreatorLeaderboards(setup.creator_user_id),
  ]);

  const activityByDeal = new Map(
    activityRows.rows.map((row) => [row.deal_id, row]),
  );
  const depositsByDeal = new Map(
    depositRows.rows.map((row) => [row.deal_id, row]),
  );

  const dealResults = await Promise.all(
    typedDeals.map(async (deal) => {
      const matchingLeaderboards = allLeaderboards
        .filter((leaderboard) =>
          overlaps(
            deal.week_start_utc,
            deal.week_end_utc,
            leaderboard.start_date,
            leaderboard.end_date,
          ),
        )
        .sort((a, b) => b.start_date.localeCompare(a.start_date));
      const leaderboards = await Promise.all(
        matchingLeaderboards.map(async (leaderboard) => {
          const standings = await getAffiliateLeaderboardPage({
            leaderboardId: leaderboard.id,
            creatorUserId: leaderboard.creator_user_id,
            coCreatorUserIds: leaderboard.co_creator_user_ids,
            affiliateCodes: leaderboard.affiliate_codes,
            startDate: new Date(leaderboard.start_date),
            endDate: new Date(leaderboard.end_date),
            prizeTiers: leaderboard.prize_tiers,
            page: 0,
            pageSize: TOP_ENTRY_LIMIT,
          });
          return {
            leaderboardId: leaderboard.id,
            title: leaderboard.title,
            status: leaderboard.time_status,
            startedAt: new Date(leaderboard.start_date).toISOString(),
            endedAt: new Date(leaderboard.end_date).toISOString(),
            totalPrizeUsd: money(leaderboard.total_prize_usd),
            totalEntries: standings.totalEntries,
            weightedWagerUsd: money(standings.totalWageredUsd),
            topEntries: standings.entries.map((entry) => ({
              rank: entry.position,
              username: entry.username?.trim() || "Anonymous player",
              wagerUsd: money(entry.totalWageredUsd),
              prizeUsd: entry.prizeUsd === null ? null : money(entry.prizeUsd),
            })),
          };
        }),
      );
      const activity = activityByDeal.get(deal.id);
      const deposits = depositsByDeal.get(deal.id);
      return {
        dealId: deal.id,
        status: deal.status,
        startedAt: new Date(deal.week_start_utc).toISOString(),
        endedAt: new Date(deal.week_end_utc).toISOString(),
        signups: Number(activity?.signups ?? 0),
        firstTimeDepositors: Number(activity?.first_time_depositors ?? 0),
        depositsUsd: money(deposits?.deposits_usd ?? 0),
        weightedWagerUsd: money(activity?.weighted_wager_usd ?? 0),
        leaderboards,
      };
    }),
  );

  return {
    generatedAt: new Date().toISOString(),
    creator: { userId: creator.id, username: creator.username },
    deals: dealResults,
  };
}
