import { db } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { toNumber } from "@/lib/utils/decimal";
import { fetchPublicStats } from "@/lib/socials-public";
import type { PaginatedResult } from "@/lib/types";

export type CreatorPnlPeriod = {
  period: string;
  ggr: number;
  costs: number;
  netPnl: number;
};

export type CreatorPnlData = {
  totalGgr: number;
  totalCosts: number;
  totalNetPnl: number;
  creatorCost: number;
  truePlatformPnl: number;
  byPeriod: CreatorPnlPeriod[];
};

const PNL_PERIODS = ["3h", "12h", "24h", "3d", "7d", "14d", "30d"] as const;

const WAGER_TYPES = "('pack_opening','battle_bet','battle_sponsorship')";
const PAYOUT_TYPES = "('battle_refund','card_sale','reward_card_sale')";
const COST_TYPES = `('deposit_bonus','promo_code_redeemed','gift_card_redeemed','waitlist_prize',
  'rakeback_claim','affiliate_claim',
  'rain_win','race_prize','balance_reward_claim','creator_tip',
  'voucher_redeemed','voucher_exchange','exchange_excess_credit',
  'exchange_excess_to_voucher','battle_excess_to_voucher')`;

export async function getCreatorPnl(userId: string): Promise<CreatorPnlData> {
  const [allTimeRows, periodRows, creatorCostRows] = await Promise.all([
    // Query A: All-time PnL from referred users
    db.$queryRawUnsafe<{ ggr: string; costs: string }[]>(`
      SELECT
        (COALESCE(SUM(CASE WHEN lt.type IN ${WAGER_TYPES} THEN ABS(lt.amount::numeric) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN lt.type IN ${PAYOUT_TYPES} THEN ABS(lt.amount::numeric) ELSE 0 END), 0))::text AS ggr,
        COALESCE(SUM(CASE WHEN lt.type IN ${COST_TYPES} THEN (lt.balance_after - lt.balance_before)::numeric ELSE 0 END), 0)::text AS costs
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.user_id IN (
          SELECT DISTINCT referred_user_id FROM affiliate_code_usages WHERE affiliate_user_id = $1
        )
    `, userId),

    // Query B: PnL by period
    db.$queryRawUnsafe<{ period: string; ggr: string; costs: string }[]>(`
      SELECT
        p.period,
        (COALESCE(SUM(CASE WHEN lt.type IN ${WAGER_TYPES} THEN ABS(lt.amount::numeric) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN lt.type IN ${PAYOUT_TYPES} THEN ABS(lt.amount::numeric) ELSE 0 END), 0))::text AS ggr,
        COALESCE(SUM(CASE WHEN lt.type IN ${COST_TYPES} THEN (lt.balance_after - lt.balance_before)::numeric ELSE 0 END), 0)::text AS costs
      FROM (VALUES ('3h'),('12h'),('24h'),('3d'),('7d'),('14d'),('30d')) AS p(period)
      LEFT JOIN ledger_transactions lt
        ON lt.status = 'completed'
        AND lt.user_id IN (
          SELECT DISTINCT referred_user_id FROM affiliate_code_usages WHERE affiliate_user_id = $1
        )
        AND lt.created_at >= NOW() - CASE p.period
          WHEN '3h'  THEN INTERVAL '3 hours'
          WHEN '12h' THEN INTERVAL '12 hours'
          WHEN '24h' THEN INTERVAL '24 hours'
          WHEN '3d'  THEN INTERVAL '3 days'
          WHEN '7d'  THEN INTERVAL '7 days'
          WHEN '14d' THEN INTERVAL '14 days'
          WHEN '30d' THEN INTERVAL '30 days'
        END
      GROUP BY p.period
    `, userId),

    // Query C: Creator's own cost to platform
    db.$queryRawUnsafe<{ commission: string; tips: string; fills: string }[]>(`
      SELECT
        COALESCE(SUM(CASE WHEN type = 'affiliate_claim' THEN (balance_after - balance_before)::numeric ELSE 0 END), 0)::text AS commission,
        COALESCE(SUM(CASE WHEN type = 'creator_tip' THEN (balance_after - balance_before)::numeric ELSE 0 END), 0)::text AS tips,
        COALESCE(SUM(CASE WHEN type = 'admin_balance_adjustment' THEN (balance_after - balance_before)::numeric ELSE 0 END), 0)::text AS fills
      FROM ledger_transactions
      WHERE user_id = $1 AND status = 'completed'
    `, userId),
  ]);

  const totalGgr = Number(allTimeRows[0]?.ggr ?? 0);
  const totalCosts = Number(allTimeRows[0]?.costs ?? 0);
  const totalNetPnl = totalGgr - totalCosts;

  const commission = Number(creatorCostRows[0]?.commission ?? 0);
  const tips = Number(creatorCostRows[0]?.tips ?? 0);
  const fills = Number(creatorCostRows[0]?.fills ?? 0);
  const creatorCost = commission + tips + fills;

  const byPeriod: CreatorPnlPeriod[] = PNL_PERIODS.map((period) => {
    const row = periodRows.find((r) => r.period === period);
    const ggr = Number(row?.ggr ?? 0);
    const costs = Number(row?.costs ?? 0);
    return { period, ggr, costs, netPnl: ggr - costs };
  });

  return {
    totalGgr,
    totalCosts,
    totalNetPnl,
    creatorCost,
    truePlatformPnl: totalNetPnl - creatorCost,
    byPeriod,
  };
}

export type CreatorLimits = {
  currencyLimitAmount: number | null;
  percentageLimit: number | null;
  tipLimit: number | null;
  currencyLimitResetDays: number | null;
};

export type CreatorListItem = {
  userId: string;
  username: string | null;
  code: string;
  level: number;
  totalReferred: number;
  totalEarnedUsd: number;
  availableUsd: number;
  totalPaidOutUsd: number;
  limits: CreatorLimits;
};

export type UserSearchResult = {
  userId: string;
  username: string | null;
  email: string | null;
  role: string;
};

export async function searchNonCreatorUsers(search: string): Promise<UserSearchResult[]> {
  if (!search || search.length < 2) return [];

  const users = await db.user.findMany({
    where: {
      role: { not: "creator" },
      OR: [
        { username: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
      ],
    },
    select: { id: true, username: true, email: true, role: true },
    take: 5,
  });

  return users.map((u) => ({
    userId: u.id,
    username: u.username,
    email: u.email,
    role: u.role,
  }));
}

export async function getCreators(params: {
  page?: number;
  perPage?: number;
  search?: string;
  sortBy?: string;
  sortOrder?: string;
}): Promise<PaginatedResult<CreatorListItem>> {
  const {
    page = 1,
    perPage = 20,
    search,
    sortBy = "created_at",
    sortOrder = "desc",
  } = params;

  const where: Record<string, unknown> = {
    user: { role: "creator" },
  };

  if (search) {
    where.OR = [
      { user: { role: "creator", username: { contains: search, mode: "insensitive" } } },
      { user: { role: "creator", affiliate_code: { contains: search, mode: "insensitive" } } },
    ];
    // Override the top-level user filter when using OR
    delete where.user;
  }

  const orderBy: Record<string, string> = {};
  const validSortFields = ["created_at", "total_earned_usd", "total_referred", "total_wager_volume_usd"];
  const field = validSortFields.includes(sortBy) ? sortBy : "created_at";
  orderBy[field] = sortOrder === "asc" ? "asc" : "desc";

  const [creators, total] = await Promise.all([
    db.affiliate_accounts.findMany({
      where,
      orderBy,
      skip: (page - 1) * perPage,
      take: perPage,
      include: {
        user: {
          select: {
            username: true,
            affiliate_code: true,
            affiliate_codes: { take: 1, orderBy: { created_at: "asc" } },
            creator_withdrawal_limits: true,
          },
        },
      },
    }),
    db.affiliate_accounts.count({ where }),
  ]);

  return {
    data: creators.map((a) => {
      const lim = a.user?.creator_withdrawal_limits;
      return {
        userId: a.user_id,
        username: a.user?.username ?? null,
        code: a.user?.affiliate_code ?? a.user?.affiliate_codes?.[0]?.code ?? "",
        level: a.affiliate_level,
        totalReferred: a.total_referred,
        totalEarnedUsd: toNumber(a.total_earned_usd),
        availableUsd: toNumber(a.available_usd),
        totalPaidOutUsd: toNumber(a.total_paid_out_usd),
        limits: {
          currencyLimitAmount: lim ? toNumber(lim.currency_limit_amount) : null,
          percentageLimit: lim ? toNumber(lim.percentage_limit) : null,
          tipLimit: lim ? toNumber(lim.tip_limit) : null,
          currencyLimitResetDays: lim?.currency_limit_reset_days ?? null,
        },
      };
    }),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

export async function getCreatorDetail(userId: string, refPage?: number, refPerPage?: number) {
  const account = await db.affiliate_accounts.findUnique({
    where: { user_id: userId },
    include: {
      user: { select: { username: true, email: true, role: true, affiliate_code: true, affiliate_code_active: true } },
    },
  });

  if (!account) return null;

  const [referrals, referralsTotal, payouts, allCodes, limits, webhooks, deals, socials, pnl] = await Promise.all([
    db.affiliate_code_usages.findMany({
      where: { affiliate_user_id: userId },
      include: {
        user_affiliate_code_usages_referred_user_idTouser: {
          select: { username: true, email: true },
        },
      },
      orderBy: { created_at: "desc" },
      skip: ((refPage ?? 1) - 1) * (refPerPage ?? 20),
      take: refPerPage ?? 20,
    }),
    db.affiliate_code_usages.count({
      where: { affiliate_user_id: userId },
    }),
    db.affiliate_payouts.findMany({
      where: { affiliate_user_id: userId },
      orderBy: { created_at: "desc" },
      take: 50,
    }),
    db.affiliate_codes.findMany({
      where: { user_id: userId },
      orderBy: { created_at: "asc" },
    }),
    db.creator_withdrawal_limits.findUnique({
      where: { user_id: userId },
    }),
    adminDb.creator_webhooks.findMany({
      where: { target_user_id: userId },
      orderBy: { created_at: "desc" },
    }),
    adminDb.creator_deals.findMany({
      where: { target_user_id: userId },
      orderBy: { created_at: "desc" },
    }),
    adminDb.creator_socials.findMany({
      where: { target_user_id: userId },
      orderBy: { platform: "asc" },
    }),
    getCreatorPnl(userId),
  ]);

  const primaryCode = account.user?.affiliate_code ?? allCodes[0]?.code ?? "";
  const clickCount = primaryCode ? await db.affiliate_clicks.count({ where: { code: primaryCode } }) : 0;

  // FTD lookup for referred users
  const referredUserIds = [...new Set(referrals.map((r) => r.referred_user_id))];
  let ftdMap = new Map<string, boolean>();
  if (referredUserIds.length > 0) {
    const balances = await db.balances.findMany({
      where: { user_id: { in: referredUserIds } },
      select: { user_id: true, total_deposited: true },
    });
    ftdMap = new Map(
      balances.map((b) => [b.user_id, toNumber(b.total_deposited) > 0])
    );
  }

  // FTD stats by period
  const ftdStats = await db.$queryRawUnsafe<
    { period: string; count: string }[]
  >(`
    SELECT period, COUNT(*)::text AS count FROM (
      SELECT DISTINCT acu.referred_user_id, p.period
      FROM affiliate_code_usages acu
      JOIN balances b ON b.user_id = acu.referred_user_id AND b.total_deposited > 0
      CROSS JOIN (VALUES ('1d'), ('3d'), ('7d'), ('14d'), ('30d'), ('all')) AS p(period)
      WHERE acu.affiliate_user_id = $1
        AND acu.usage_type = 'deposit'
        AND (
          p.period = 'all'
          OR acu.created_at >= NOW() - CASE p.period
            WHEN '1d' THEN INTERVAL '1 day'
            WHEN '3d' THEN INTERVAL '3 days'
            WHEN '7d' THEN INTERVAL '7 days'
            WHEN '14d' THEN INTERVAL '14 days'
            WHEN '30d' THEN INTERVAL '30 days'
          END
        )
    ) sub
    GROUP BY period
  `, userId);

  const ftdByPeriod: Record<string, number> = { "1d": 0, "3d": 0, "7d": 0, "14d": 0, "30d": 0, all: 0 };
  for (const row of ftdStats) {
    ftdByPeriod[row.period] = Number(row.count);
  }

  return {
    userId: account.user_id,
    username: account.user?.username ?? null,
    email: account.user?.email ?? null,
    role: account.user?.role ?? "user",
    code: primaryCode,
    codeActive: account.user?.affiliate_code_active ?? false,
    level: account.affiliate_level,
    totalReferred: account.total_referred,
    totalWagerVolumeUsd: toNumber(account.total_wager_volume_usd),
    totalEarnedUsd: toNumber(account.total_earned_usd),
    availableUsd: toNumber(account.available_usd),
    totalPaidOutUsd: toNumber(account.total_paid_out_usd),
    totalBonusDistributedUsd: toNumber(account.total_bonus_distributed_usd),
    lastPayoutAt: account.last_payout_at?.toISOString() ?? null,
    totalClicks: clickCount,
    ftdByPeriod,
    pnl,
    createdAt: account.created_at.toISOString(),
    additionalCodes: allCodes.map((c) => ({
      id: c.id,
      code: c.code,
      isActive: c.is_active,
      createdAt: c.created_at.toISOString(),
    })),
    limits: limits
      ? {
          id: limits.id,
          currencyLimitAmount: toNumber(limits.currency_limit_amount),
          percentageLimit: toNumber(limits.percentage_limit),
          tipLimit: toNumber(limits.tip_limit),
          currencyLimitResetDays: limits.currency_limit_reset_days,
        }
      : null,
    referrals: {
      data: referrals.map((r) => ({
        id: r.id,
        referredUserId: r.referred_user_id,
        referredUsername: r.user_affiliate_code_usages_referred_user_idTouser?.username ?? null,
        usageType: r.usage_type,
        depositAmountUsd: toNumber(r.deposit_amount_usd),
        wagerAmountUsd: toNumber(r.wager_amount_usd),
        referrerCutUsd: toNumber(r.referrer_cut_usd),
        userBonusUsd: toNumber(r.user_bonus_usd),
        isFtd: ftdMap.get(r.referred_user_id) ?? false,
        createdAt: r.created_at.toISOString(),
      })),
      total: referralsTotal,
      page: refPage ?? 1,
      perPage: refPerPage ?? 20,
      totalPages: Math.ceil(referralsTotal / (refPerPage ?? 20)),
    },
    payouts: payouts.map((p) => ({
      id: p.id,
      amountUsd: toNumber(p.amount_usd),
      status: p.status,
      createdAt: p.created_at.toISOString(),
    })),
    webhooks: await Promise.all(webhooks.map(async (w) => {
      const deliveries = await adminDb.webhook_deliveries.findMany({
        where: { webhook_id: w.id },
        orderBy: { created_at: "desc" },
        take: 5,
      });
      return {
        id: w.id,
        url: w.url,
        type: w.type,
        enabled: w.enabled,
        createdAt: w.created_at.toISOString(),
        deliveries: deliveries.map((d) => ({
          id: d.id,
          eventType: d.event_type,
          statusCode: d.status_code,
          success: d.success,
          attempt: d.attempt,
          createdAt: d.created_at.toISOString(),
        })),
      };
    })),
    deals: deals.map((d) => ({
      id: d.id,
      dealName: d.deal_name,
      dealType: d.deal_type,
      amount: toNumber(d.amount),
      currency: d.currency,
      startDate: d.start_date.toISOString(),
      endDate: d.end_date?.toISOString() ?? null,
      status: d.status,
      notes: d.notes,
      dailyFillAmount: toNumber(d.daily_fill_amount),
      dailyFillTime: d.daily_fill_time,
      dailyFillEnabled: d.daily_fill_enabled,
      keepPercentage: toNumber(d.keep_percentage),
      currencyLimitAmount: toNumber(d.currency_limit_amount),
      currencyLimitResetDays: d.currency_limit_reset_days,
      percentageLimit: toNumber(d.percentage_limit),
      tipLimit: toNumber(d.tip_limit),
      tipLimitResetDays: d.tip_limit_reset_days,
      leaderboardPrizePool: toNumber(d.leaderboard_prize_pool),
      leaderboardOurShare: toNumber(d.leaderboard_our_share),
      leaderboardFrequency: d.leaderboard_frequency,
      minStreamMinutes: d.min_stream_minutes,
      maxFinancialExposure: toNumber(d.max_financial_exposure),
      createdAt: d.created_at.toISOString(),
    })),
    socials: socials.map((s) => ({
      id: s.id,
      platform: s.platform,
      username: s.username,
      followerCount: s.follower_count,
      subscriberCount: s.subscriber_count,
      totalViews: s.total_views ? Number(s.total_views) : null,
      avgViews30d: s.avg_views_30d,
      avgViewers: s.avg_viewers,
      avgViewers30d: s.avg_viewers_30d,
      engagementRate: s.engagement_rate ? toNumber(s.engagement_rate) : null,
      likesAvg: s.likes_avg,
      lastFetchedAt: s.last_fetched_at?.toISOString() ?? null,
    })),
  };
}

export type CodeListItem = {
  code: string;
  ownerUserId: string;
  ownerUsername: string | null;
  isActive: boolean;
  createdAt: string;
};

export async function getCodes(params: {
  page?: number;
  perPage?: number;
  search?: string;
  sortBy?: string;
  sortOrder?: string;
}): Promise<PaginatedResult<CodeListItem>> {
  const {
    page = 1,
    perPage = 20,
    search,
    sortBy = "created_at",
    sortOrder = "desc",
  } = params;

  const where: Record<string, unknown> = {};
  if (search) {
    where.OR = [
      { code: { contains: search, mode: "insensitive" } },
      { user: { username: { contains: search, mode: "insensitive" } } },
    ];
  }

  const orderBy: Record<string, string> = {};
  const validFields = ["code", "created_at"];
  const sortField = validFields.includes(sortBy) ? sortBy : "created_at";
  orderBy[sortField] = sortOrder === "asc" ? "asc" : "desc";

  const [codes, total] = await Promise.all([
    db.affiliate_codes.findMany({
      where,
      include: {
        user: { select: { username: true } },
      },
      orderBy,
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    db.affiliate_codes.count({ where }),
  ]);

  return {
    data: codes.map((c) => ({
      code: c.code,
      ownerUserId: c.user_id,
      ownerUsername: c.user?.username ?? null,
      isActive: c.is_active,
      createdAt: c.created_at.toISOString(),
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

export async function getCodeAnalytics(code: string) {
  const [
    codeRecord,
    usages,
    clickCount,
    dailyUsages,
    dailyClicks,
  ] = await Promise.all([
    db.affiliate_codes.findFirst({
      where: { code },
      include: { user: { select: { username: true } } },
    }),
    db.affiliate_code_usages.findMany({
      where: { code },
      include: {
        user_affiliate_code_usages_referred_user_idTouser: {
          select: { username: true },
        },
      },
      orderBy: { created_at: "desc" },
      take: 50,
    }),
    db.affiliate_clicks.count({ where: { code } }),
    db.$queryRawUnsafe<
      {
        date: Date;
        referrals: string;
        deposit_volume: string;
        wager_volume: string;
        commission: string;
      }[]
    >(`
      SELECT
        DATE(created_at) AS date,
        COUNT(*)::text AS referrals,
        COALESCE(SUM(deposit_amount_usd::numeric), 0)::text AS deposit_volume,
        COALESCE(SUM(wager_amount_usd::numeric), 0)::text AS wager_volume,
        COALESCE(SUM(referrer_cut_usd::numeric), 0)::text AS commission
      FROM affiliate_code_usages
      WHERE code = $1
      GROUP BY DATE(created_at)
      ORDER BY date
    `, code),
    db.$queryRawUnsafe<{ date: Date; clicks: string }[]>(`
      SELECT DATE(created_at) AS date, COUNT(*)::text AS clicks
      FROM affiliate_clicks
      WHERE code = $1
      GROUP BY DATE(created_at)
      ORDER BY date
    `, code),
  ]);

  if (!codeRecord) return null;

  const isActive = codeRecord.is_active;

  const totalReferrals = usages.length;
  const totalDeposits = usages.reduce((sum, u) => sum + toNumber(u.deposit_amount_usd), 0);
  const totalWagers = usages.reduce((sum, u) => sum + toNumber(u.wager_amount_usd), 0);
  const totalCommission = usages.reduce((sum, u) => sum + toNumber(u.referrer_cut_usd), 0);

  // Merge daily data
  const clicksMap = new Map(
    dailyClicks.map((d) => [new Date(d.date).toISOString().split("T")[0], Number(d.clicks)])
  );

  const daily = dailyUsages.map((d) => {
    const dateStr = new Date(d.date).toISOString().split("T")[0];
    return {
      date: dateStr,
      referrals: Number(d.referrals),
      depositVolume: toNumber(d.deposit_volume),
      wagerVolume: toNumber(d.wager_volume),
      commission: toNumber(d.commission),
      clicks: clicksMap.get(dateStr) ?? 0,
    };
  });

  for (const [dateStr, clicks] of clicksMap) {
    if (!daily.find((d) => d.date === dateStr)) {
      daily.push({ date: dateStr, referrals: 0, depositVolume: 0, wagerVolume: 0, commission: 0, clicks });
    }
  }
  daily.sort((a, b) => a.date.localeCompare(b.date));

  return {
    code,
    ownerUserId: codeRecord.user_id,
    ownerUsername: codeRecord.user?.username ?? null,
    isActive,
    totalReferrals,
    totalDeposits,
    totalWagers,
    totalCommission,
    totalClicks: clickCount,
    daily,
    recentReferrals: usages.map((u) => ({
      id: u.id,
      referredUserId: u.referred_user_id,
      referredUsername: u.user_affiliate_code_usages_referred_user_idTouser?.username ?? null,
      usageType: u.usage_type,
      depositAmountUsd: toNumber(u.deposit_amount_usd),
      wagerAmountUsd: toNumber(u.wager_amount_usd),
      referrerCutUsd: toNumber(u.referrer_cut_usd),
      createdAt: u.created_at.toISOString(),
    })),
  };
}

type Period = "today" | "7d" | "30d" | "90d" | "all";

function periodToDateFilter(period: Period): string {
  switch (period) {
    case "today":
      return "AND created_at >= NOW() - INTERVAL '1 day'";
    case "7d":
      return "AND created_at >= NOW() - INTERVAL '7 days'";
    case "30d":
      return "AND created_at >= NOW() - INTERVAL '30 days'";
    case "90d":
      return "AND created_at >= NOW() - INTERVAL '90 days'";
    case "all":
      return "";
  }
}

export type AffiliateAnalyticsData = {
  totalSignups: number;
  totalCommissionPaid: number;
  totalWagerVolume: number;
  totalDepositVolume: number;
  totalClicks: number;
  activeCreators: number;
  daily: {
    date: string;
    signups: number;
    commission: number;
    wagerVolume: number;
    depositVolume: number;
    clicks: number;
  }[];
};

export async function getAffiliateAnalytics(period: Period): Promise<AffiliateAnalyticsData> {
  const dateFilter = periodToDateFilter(period);

  const [signupsAgg, payoutsAgg, usagesAgg, clicksAgg, activeCreators, dailyUsages, dailyClicks] =
    await Promise.all([
      db.$queryRawUnsafe<{ count: string }[]>(`
        SELECT COUNT(*)::text AS count
        FROM affiliate_code_usages
        WHERE usage_type = 'deposit' ${dateFilter}
      `),
      db.$queryRawUnsafe<{ total: string }[]>(`
        SELECT COALESCE(SUM(amount_usd::numeric), 0)::text AS total
        FROM affiliate_payouts
        WHERE status = 'paid' ${dateFilter}
      `),
      db.$queryRawUnsafe<{ wager: string; deposit: string }[]>(`
        SELECT
          COALESCE(SUM(wager_amount_usd::numeric), 0)::text AS wager,
          COALESCE(SUM(deposit_amount_usd::numeric), 0)::text AS deposit
        FROM affiliate_code_usages
        WHERE 1=1 ${dateFilter}
      `),
      db.$queryRawUnsafe<{ count: string }[]>(`
        SELECT COUNT(*)::text AS count
        FROM affiliate_clicks
        WHERE 1=1 ${dateFilter}
      `),
      db.affiliate_accounts.count({
        where: {
          user: { role: "creator", affiliate_code_active: true },
        },
      }),
      db.$queryRawUnsafe<
        { date: Date; signups: string; wager: string; deposit: string; commission: string }[]
      >(`
        SELECT
          DATE(created_at) AS date,
          COUNT(CASE WHEN usage_type = 'deposit' THEN 1 END)::text AS signups,
          COALESCE(SUM(wager_amount_usd::numeric), 0)::text AS wager,
          COALESCE(SUM(deposit_amount_usd::numeric), 0)::text AS deposit,
          COALESCE(SUM(referrer_cut_usd::numeric), 0)::text AS commission
        FROM affiliate_code_usages
        WHERE 1=1 ${dateFilter}
        GROUP BY DATE(created_at)
        ORDER BY date
      `),
      db.$queryRawUnsafe<{ date: Date; clicks: string }[]>(`
        SELECT DATE(created_at) AS date, COUNT(*)::text AS clicks
        FROM affiliate_clicks
        WHERE 1=1 ${dateFilter}
        GROUP BY DATE(created_at)
        ORDER BY date
      `),
    ]);

  const clicksMap = new Map(
    dailyClicks.map((d) => [new Date(d.date).toISOString().split("T")[0], Number(d.clicks)])
  );

  const daily = dailyUsages.map((d) => {
    const dateStr = new Date(d.date).toISOString().split("T")[0];
    return {
      date: dateStr,
      signups: Number(d.signups),
      commission: toNumber(d.commission),
      wagerVolume: toNumber(d.wager),
      depositVolume: toNumber(d.deposit),
      clicks: clicksMap.get(dateStr) ?? 0,
    };
  });

  for (const [dateStr, clicks] of clicksMap) {
    if (!daily.find((d) => d.date === dateStr)) {
      daily.push({ date: dateStr, signups: 0, commission: 0, wagerVolume: 0, depositVolume: 0, clicks });
    }
  }
  daily.sort((a, b) => a.date.localeCompare(b.date));

  return {
    totalSignups: Number(signupsAgg[0]?.count ?? 0),
    totalCommissionPaid: toNumber(payoutsAgg[0]?.total),
    totalWagerVolume: toNumber(usagesAgg[0]?.wager),
    totalDepositVolume: toNumber(usagesAgg[0]?.deposit),
    totalClicks: Number(clicksAgg[0]?.count ?? 0),
    activeCreators,
    daily,
  };
}

export async function getAffiliateLevelConfigs() {
  const configs = await db.affiliate_level_configs.findMany({
    orderBy: { level: "asc" },
  });
  return configs.map((c) => ({
    level: c.level,
    label: c.label,
    commission_rate: toNumber(c.commission_rate),
    threshold: toNumber(c.threshold),
  }));
}

const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

/**
 * Refresh social stats for a creator if stale (>1 hour since last fetch).
 * Called on page load — non-blocking, fires and forgets.
 */
export async function refreshStaleSocials(userId: string): Promise<void> {
  const socials = await adminDb.creator_socials.findMany({
    where: { target_user_id: userId },
  });

  const now = Date.now();

  for (const social of socials) {
    const lastFetched = social.last_fetched_at?.getTime() ?? 0;
    if (now - lastFetched < STALE_THRESHOLD_MS) continue;

    try {
      const stats = await fetchPublicStats(social.platform, social.username);

      await adminDb.creator_socials.update({
        where: { id: social.id },
        data: {
          follower_count: stats.followerCount ?? social.follower_count,
          platform_user_id: stats.platformUserId ?? social.platform_user_id,
          last_fetched_at: new Date(),
          updated_at: new Date(),
        },
      });
    } catch (error) {
      console.error(`Failed to refresh ${social.platform} stats for ${userId}:`, error);
    }
  }
}
