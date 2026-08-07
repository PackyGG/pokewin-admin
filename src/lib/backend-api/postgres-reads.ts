import "server-only";

import {
  and,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";

import { getReadDrizzleDb } from "@/lib/db";
import {
  affiliate_leaderboard_prize_tiers,
  affiliate_leaderboards,
  creator_deals,
  creator_session_pending_conversions,
  creator_socials,
  creator_stream_sessions,
  user,
} from "@/lib/db-schema/main/schema";

import type {
  AdminCreatorSocial,
  ApprovalStatus,
  CreatorDealResponse,
  CreatorListItem,
  CreatorSessionResponse,
  CreatorSocialStatus,
  LeaderboardAdminRow,
  LeaderboardListQuery,
  LeaderboardListResult,
  PendingConversionResponse,
  PendingConversionStatus,
  TimeStatus,
} from "./contracts";

type ListQuery = LeaderboardListQuery;
type ListResult = LeaderboardListResult;

type CreatorListQuery = {
  search?: string;
  offset?: number;
  limit?: number;
};

type PageBounds = {
  offset: number;
  limit: number;
};

function pageBounds(
  query: { offset?: number; limit?: number },
  defaultLimit = 50,
): PageBounds {
  return {
    offset: Math.max(0, Math.trunc(query.offset ?? 0)),
    limit: Math.min(100, Math.max(1, Math.trunc(query.limit ?? defaultLimit))),
  };
}

export async function listCreatorsFromPostgres(
  query: CreatorListQuery = {},
): Promise<{
  data: CreatorListItem[];
  total: number;
  offset: number;
  limit: number;
}> {
  const db = await getReadDrizzleDb();
  const { offset, limit } = pageBounds(query);
  const search = query.search?.trim();
  const where = search
    ? and(
        eq(user.role, "creator"),
        or(
          ilike(user.username, `%${search}%`),
          ilike(user.email, `%${search}%`),
        ),
      )
    : eq(user.role, "creator");

  const [creators, totalRows] = await Promise.all([
    db
      .select({
        id: user.id,
        username: user.username,
        email: user.email,
        image: user.image,
        created_at: user.created_at,
      })
      .from(user)
      .where(where)
      .orderBy(desc(user.created_at))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(user)
      .where(where),
  ]);

  if (creators.length === 0) {
    return {
      data: [],
      total: totalRows[0]?.count ?? 0,
      offset,
      limit,
    };
  }

  const ids = creators.map((creator) => creator.id);
  const now = new Date().toISOString();
  const [currentDeals, activeSessions, dealCounts] = await Promise.all([
    db
      .select({
        id: creator_deals.id,
        user_id: creator_deals.user_id,
        status: creator_deals.status,
        week_start_utc: creator_deals.week_start_utc,
        week_end_utc: creator_deals.week_end_utc,
        fills_allowed: creator_deals.fills_allowed,
        fills_used: creator_deals.fills_used,
        per_fill_amount_usd: creator_deals.per_fill_amount_usd,
      })
      .from(creator_deals)
      .where(
        and(
          inArray(creator_deals.user_id, ids),
          inArray(creator_deals.status, ["scheduled", "active"]),
          sql`${creator_deals.week_start_utc} <= ${now}`,
          sql`${creator_deals.week_end_utc} > ${now}`,
        ),
      )
      .orderBy(desc(creator_deals.week_start_utc)),
    db
      .select({
        id: creator_stream_sessions.id,
        user_id: creator_stream_sessions.user_id,
      })
      .from(creator_stream_sessions)
      .where(
        and(
          inArray(creator_stream_sessions.user_id, ids),
          eq(creator_stream_sessions.status, "active"),
        ),
      ),
    db
      .select({
        user_id: creator_deals.user_id,
        count: sql<number>`count(*)::int`,
      })
      .from(creator_deals)
      .where(inArray(creator_deals.user_id, ids))
      .groupBy(creator_deals.user_id),
  ]);

  const dealByUser = new Map<
    string,
    (typeof currentDeals)[number]
  >();
  for (const deal of currentDeals) {
    if (!dealByUser.has(deal.user_id)) dealByUser.set(deal.user_id, deal);
  }
  const sessionByUser = new Map(
    activeSessions.map((session) => [session.user_id, session.id]),
  );
  const countByUser = new Map(
    dealCounts.map((row) => [row.user_id, row.count]),
  );

  return {
    data: creators.map((creator) => {
      const deal = dealByUser.get(creator.id);
      return {
        ...creator,
        role: "creator" as const,
        current_deal: deal
          ? {
              id: deal.id,
              status: deal.status,
              week_start_utc: deal.week_start_utc,
              week_end_utc: deal.week_end_utc,
              fills_allowed: deal.fills_allowed,
              fills_used: deal.fills_used,
              per_fill_amount_usd: deal.per_fill_amount_usd,
            }
          : null,
        active_session_id: sessionByUser.get(creator.id) ?? null,
        total_deals_count: countByUser.get(creator.id) ?? 0,
      };
    }),
    total: totalRows[0]?.count ?? 0,
    offset,
    limit,
  };
}

export async function listCreatorDealsFromPostgres(
  userId: string,
  query: { offset?: number; limit?: number } = {},
): Promise<{
  data: CreatorDealResponse[];
  total: number;
  offset: number;
  limit: number;
}> {
  const db = await getReadDrizzleDb();
  const { offset, limit } = pageBounds(query);
  const where = eq(creator_deals.user_id, userId);
  const [data, totalRows] = await Promise.all([
    db
      .select()
      .from(creator_deals)
      .where(where)
      .orderBy(desc(creator_deals.week_start_utc))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(creator_deals)
      .where(where),
  ]);
  return {
    data,
    total: totalRows[0]?.count ?? 0,
    offset,
    limit,
  };
}

export async function getCreatorDealFromPostgres(
  userId: string,
  dealId: string,
): Promise<CreatorDealResponse | null> {
  const db = await getReadDrizzleDb();
  const [deal] = await db
    .select()
    .from(creator_deals)
    .where(
      and(eq(creator_deals.user_id, userId), eq(creator_deals.id, dealId)),
    )
    .limit(1);
  return deal ?? null;
}

export async function listCreatorSessionsFromPostgres(
  userId: string,
  query: {
    status?: CreatorSessionResponse["status"];
    offset?: number;
    limit?: number;
  } = {},
): Promise<{
  data: CreatorSessionResponse[];
  total: number;
  offset: number;
  limit: number;
}> {
  const db = await getReadDrizzleDb();
  const { offset, limit } = pageBounds(query);
  const where = query.status
    ? and(
        eq(creator_stream_sessions.user_id, userId),
        eq(creator_stream_sessions.status, query.status),
      )
    : eq(creator_stream_sessions.user_id, userId);
  const [data, totalRows] = await Promise.all([
    db
      .select({
        id: creator_stream_sessions.id,
        deal_id: creator_stream_sessions.deal_id,
        user_id: creator_stream_sessions.user_id,
        status: creator_stream_sessions.status,
        activated_at: creator_stream_sessions.activated_at,
        first_bet_at: creator_stream_sessions.first_bet_at,
        ended_at: creator_stream_sessions.ended_at,
        converted_at: creator_stream_sessions.converted_at,
        auto_end_at: creator_stream_sessions.auto_end_at,
        fill_loaded_usd: creator_stream_sessions.fill_loaded_usd,
        fill_spent_usd: creator_stream_sessions.fill_spent_usd,
        fill_refunded_usd: creator_stream_sessions.fill_refunded_usd,
        fill_remaining_usd: creator_stream_sessions.fill_remaining_usd,
        tips_spent_this_session_usd:
          creator_stream_sessions.tips_spent_this_session_usd,
        sponsorship_spent_this_session_usd:
          creator_stream_sessions.sponsorship_spent_this_session_usd,
        ending_balance_usd: creator_stream_sessions.ending_balance_usd,
        conversion_rate_bps_snapshot:
          creator_stream_sessions.conversion_rate_bps_snapshot,
        converted_to_raw_usd: creator_stream_sessions.converted_to_raw_usd,
        version: creator_stream_sessions.version,
        created_at: creator_stream_sessions.created_at,
      })
      .from(creator_stream_sessions)
      .where(where)
      .orderBy(desc(creator_stream_sessions.activated_at))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(creator_stream_sessions)
      .where(where),
  ]);
  return {
    data,
    total: totalRows[0]?.count ?? 0,
    offset,
    limit,
  };
}

export async function listPendingConversionsFromPostgres(
  userId: string,
  query: { status?: PendingConversionStatus } = {},
): Promise<PendingConversionResponse[]> {
  const db = await getReadDrizzleDb();
  const where = query.status
    ? and(
        eq(creator_session_pending_conversions.user_id, userId),
        eq(creator_session_pending_conversions.status, query.status),
      )
    : eq(creator_session_pending_conversions.user_id, userId);
  return db
    .select({
      id: creator_session_pending_conversions.id,
      session_id: creator_session_pending_conversions.session_id,
      deal_id: creator_session_pending_conversions.deal_id,
      user_id: creator_session_pending_conversions.user_id,
      source: creator_session_pending_conversions.source,
      amount_usd: creator_session_pending_conversions.amount_usd,
      battle_id: creator_session_pending_conversions.battle_id,
      conversion_rate_bps_snapshot:
        creator_session_pending_conversions.conversion_rate_bps_snapshot,
      status: creator_session_pending_conversions.status,
      claimed_at: creator_session_pending_conversions.claimed_at,
      created_at: creator_session_pending_conversions.created_at,
    })
    .from(creator_session_pending_conversions)
    .where(where)
    .orderBy(desc(creator_session_pending_conversions.created_at))
    .limit(500);
}

export async function listCreatorSocialsFromPostgres(
  query: {
    status?: CreatorSocialStatus;
    offset?: number;
    limit?: number;
  } = {},
): Promise<{ items: AdminCreatorSocial[]; total: number }> {
  const db = await getReadDrizzleDb();
  const { offset, limit } = pageBounds(query);
  const where = query.status
    ? eq(creator_socials.status, query.status)
    : undefined;
  const [items, totalRows] = await Promise.all([
    db
      .select({
        id: creator_socials.id,
        user_id: creator_socials.user_id,
        platform: creator_socials.platform,
        username: creator_socials.username,
        url: creator_socials.url,
        status: creator_socials.status,
        submitted_at: creator_socials.submitted_at,
        reviewed_at: creator_socials.reviewed_at,
        reviewed_by: creator_socials.reviewed_by,
        rejection_reason: creator_socials.rejection_reason,
        creator_username: user.username,
        creator_image: user.image,
      })
      .from(creator_socials)
      .leftJoin(user, eq(user.id, creator_socials.user_id))
      .where(where)
      .orderBy(desc(creator_socials.submitted_at))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(creator_socials)
      .where(where),
  ]);
  return { items, total: totalRows[0]?.count ?? 0 };
}

type LeaderboardRowWithoutTiers = Omit<
  LeaderboardAdminRow,
  "prize_tiers" | "approval_status"
> & {
  approval_status: string;
};

function leaderboardWhere(query: ListQuery) {
  const conditions = [];
  if (query.status) {
    conditions.push(eq(affiliate_leaderboards.approval_status, query.status));
  }
  if (query.creator_user_id) {
    conditions.push(
      eq(affiliate_leaderboards.creator_user_id, query.creator_user_id),
    );
  }
  if (!query.include_cancelled) {
    conditions.push(isNull(affiliate_leaderboards.cancelled_at));
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

function selectLeaderboardRows() {
  return {
    id: affiliate_leaderboards.id,
    creator_user_id: affiliate_leaderboards.creator_user_id,
    co_creator_user_ids: affiliate_leaderboards.co_creator_user_ids,
    title: affiliate_leaderboards.title,
    affiliate_codes: affiliate_leaderboards.affiliate_codes,
    creator_prize_usd: affiliate_leaderboards.creator_prize_usd,
    site_bonus_usd: affiliate_leaderboards.site_bonus_usd,
    total_prize_usd:
      sql<string>`(${affiliate_leaderboards.creator_prize_usd} + ${affiliate_leaderboards.site_bonus_usd})::text`,
    is_sponsored:
      sql<boolean>`${affiliate_leaderboards.site_bonus_usd} > 0`,
    start_date: affiliate_leaderboards.start_date,
    end_date: affiliate_leaderboards.end_date,
    created_at: affiliate_leaderboards.created_at,
    approval_status: affiliate_leaderboards.approval_status,
    approved_at: affiliate_leaderboards.approved_at,
    approved_by: affiliate_leaderboards.approved_by,
    rejection_reason: affiliate_leaderboards.rejection_reason,
    cancelled_at: affiliate_leaderboards.cancelled_at,
    cancelled_by: affiliate_leaderboards.cancelled_by,
    refunded_at: affiliate_leaderboards.refunded_at,
    refund_amount_usd: affiliate_leaderboards.refund_amount_usd,
    creation_ledger_tx_id: affiliate_leaderboards.creation_ledger_tx_id,
    refund_ledger_tx_id: affiliate_leaderboards.refund_ledger_tx_id,
    paid_manually: affiliate_leaderboards.paid_manually,
    payout_note: affiliate_leaderboards.payout_note,
    time_status: sql<TimeStatus>`CASE
      WHEN ${affiliate_leaderboards.start_date} > now() THEN 'upcoming'
      WHEN ${affiliate_leaderboards.end_date} > now() THEN 'active'
      ELSE 'ended'
    END`,
  };
}

async function attachPrizeTiers(
  rows: LeaderboardRowWithoutTiers[],
): Promise<LeaderboardAdminRow[]> {
  if (rows.length === 0) return [];
  const db = await getReadDrizzleDb();
  const tiers = await db
    .select({
      leaderboard_id: affiliate_leaderboard_prize_tiers.leaderboard_id,
      position: affiliate_leaderboard_prize_tiers.position,
      prize_amount_usd:
        affiliate_leaderboard_prize_tiers.prize_amount_usd,
    })
    .from(affiliate_leaderboard_prize_tiers)
    .where(
      inArray(
        affiliate_leaderboard_prize_tiers.leaderboard_id,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(affiliate_leaderboard_prize_tiers.position);
  const byLeaderboard = new Map<string, LeaderboardAdminRow["prize_tiers"]>();
  for (const tier of tiers) {
    const list = byLeaderboard.get(tier.leaderboard_id) ?? [];
    list.push({
      position: tier.position,
      prize_amount_usd: tier.prize_amount_usd,
    });
    byLeaderboard.set(tier.leaderboard_id, list);
  }
  return rows.map((row) => ({
    ...row,
    approval_status: row.approval_status as ApprovalStatus,
    prize_tiers: byLeaderboard.get(row.id) ?? [],
  }));
}

export async function listAffiliateLeaderboardsFromPostgres(
  query: ListQuery = {},
): Promise<ListResult> {
  const db = await getReadDrizzleDb();
  const { offset, limit } = pageBounds(query);
  const where = leaderboardWhere(query);
  const [rows, totalRows] = await Promise.all([
    db
      .select(selectLeaderboardRows())
      .from(affiliate_leaderboards)
      .where(where)
      .orderBy(desc(affiliate_leaderboards.created_at))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(affiliate_leaderboards)
      .where(where),
  ]);
  return {
    leaderboards: await attachPrizeTiers(
      rows as unknown as LeaderboardRowWithoutTiers[],
    ),
    total: totalRows[0]?.count ?? 0,
    offset,
    limit,
  };
}

export async function getAffiliateLeaderboardFromPostgres(
  id: string,
): Promise<LeaderboardAdminRow | null> {
  const db = await getReadDrizzleDb();
  const [row] = await db
    .select(selectLeaderboardRows())
    .from(affiliate_leaderboards)
    .where(eq(affiliate_leaderboards.id, id))
    .limit(1);
  if (!row) return null;
  const [withTiers] = await attachPrizeTiers([
    row as unknown as LeaderboardRowWithoutTiers,
  ]);
  return withTiers ?? null;
}

export async function getCreatorApiKeyStatusFromPostgres(
  userId: string,
): Promise<{ has_api_key: boolean } | null> {
  const db = await getReadDrizzleDb();
  const [row] = await db
    .select({
      has_api_key: sql<boolean>`${isNotNull(user.api_key)} AND ${user.api_key} <> ''`,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return row ?? null;
}
