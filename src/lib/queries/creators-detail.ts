import { db } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { toNumber } from "@/lib/utils/decimal";
import type { PaginatedResult } from "@/lib/types";
import { getCreatorPnl } from "./creators-pnl";
import type { CreatorTipItem } from "./creators-types";

export async function getCreatorDetail(userId: string, refPage?: number, refPerPage?: number) {
  const account = await db.affiliate_accounts.findUnique({
    where: { user_id: userId },
    select: {
      user_id: true,
      total_referred: true,
      total_wager_volume_usd: true,
      total_earned_usd: true,
      available_usd: true,
      total_paid_out_usd: true,
      total_bonus_distributed_usd: true,
      last_payout_at: true,
      created_at: true,
      user: { select: { username: true, email: true, role: true, affiliate_code: true, affiliate_code_active: true } },
    },
  });

  if (!account) return null;

  // Referrals list now sources from signups (user.referred_by = creatorId) so
  // we show every user who registered via this creator's link — including
  // those who haven't deposited/wagered yet. The previous implementation
  // pulled from affiliate_code_usages, which only records deposit/wager
  // events, so freshly-signed-up users were invisible in the list.
  const [referrals, referralsTotal, payouts, allCodes, limits, webhooks, deals, socials, pnl] = await Promise.all([
    db.user.findMany({
      where: { referred_by: userId },
      select: {
        id: true,
        username: true,
        email: true,
        created_at: true,
      },
      orderBy: { created_at: "desc" },
      skip: ((refPage ?? 1) - 1) * (refPerPage ?? 20),
      take: refPerPage ?? 20,
    }),
    db.user.count({
      where: { referred_by: userId },
    }),
    db.affiliate_payouts.findMany({
      where: { affiliate_user_id: userId },
      orderBy: { created_at: "desc" },
      take: 50,
    }),
    db.$queryRawUnsafe<{ id: string; code: string; created_at: Date }[]>(
      `SELECT id, code, created_at FROM affiliate_codes WHERE user_id = $1 ORDER BY created_at ASC`,
      userId
    ),
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

  // Signup count — users who registered via this creator's link and got
  // attributed. user.referred_by stores the creator's USER ID (not the
  // code), so this count captures everyone who signed up through them
  // regardless of whether they later deposited / wagered.
  // account.total_referred only counts users who produced a usage event
  // (deposit or wager), so signups is always >= total_referred.
  // affiliate_code_queue rows are users mid-attribution (signed up but
  // haven't finished attribution yet — expires after a window); we show
  // them as a separate "pending" count for visibility.
  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const [
    signupsTotal,
    signups24h,
    signups7d,
    signups30d,
    pendingSignups,
  ] = await Promise.all([
    db.user.count({ where: { referred_by: userId } }),
    db.user.count({
      where: { referred_by: userId, created_at: { gte: oneDayAgo } },
    }),
    db.user.count({
      where: { referred_by: userId, created_at: { gte: sevenDaysAgo } },
    }),
    db.user.count({
      where: { referred_by: userId, created_at: { gte: thirtyDaysAgo } },
    }),
    primaryCode
      ? db.affiliate_code_queue.count({ where: { code: primaryCode } })
      : Promise.resolve(0),
  ]);

  // For each signed-up user, look up their aggregated usage data +
  // balance. If the user hasn't deposited/wagered yet we still show
  // them in the list with zeros, so the admin can see who signed up.
  const referredUserIds = referrals.map((r) => r.id);
  const usageMap = new Map<
    string,
    {
      depositAmountUsd: number;
      wagerAmountUsd: number;
      referrerCutUsd: number;
      userBonusUsd: number;
      usageCount: number;
      lastUsageType: string | null;
    }
  >();
  let ftdMap = new Map<string, boolean>();
  if (referredUserIds.length > 0) {
    const [usages, balances] = await Promise.all([
      db.affiliate_code_usages.findMany({
        where: {
          affiliate_user_id: userId,
          referred_user_id: { in: referredUserIds },
        },
        orderBy: { created_at: "desc" },
      }),
      db.balances.findMany({
        where: { user_id: { in: referredUserIds } },
        select: { user_id: true, total_deposited: true },
      }),
    ]);
    for (const u of usages) {
      const prev = usageMap.get(u.referred_user_id) ?? {
        depositAmountUsd: 0,
        wagerAmountUsd: 0,
        referrerCutUsd: 0,
        userBonusUsd: 0,
        usageCount: 0,
        lastUsageType: null,
      };
      usageMap.set(u.referred_user_id, {
        depositAmountUsd: prev.depositAmountUsd + toNumber(u.deposit_amount_usd),
        wagerAmountUsd: prev.wagerAmountUsd + toNumber(u.wager_amount_usd),
        referrerCutUsd: prev.referrerCutUsd + toNumber(u.referrer_cut_usd),
        userBonusUsd: prev.userBonusUsd + toNumber(u.user_bonus_usd),
        usageCount: prev.usageCount + 1,
        lastUsageType: prev.lastUsageType ?? u.usage_type,
      });
    }
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
    level: 1,
    totalReferred: account.total_referred,
    totalWagerVolumeUsd: toNumber(account.total_wager_volume_usd),
    totalEarnedUsd: toNumber(account.total_earned_usd),
    availableUsd: toNumber(account.available_usd),
    totalPaidOutUsd: toNumber(account.total_paid_out_usd),
    totalBonusDistributedUsd: toNumber(account.total_bonus_distributed_usd),
    lastPayoutAt: account.last_payout_at?.toISOString() ?? null,
    totalClicks: clickCount,
    signups: {
      total: signupsTotal,
      last24h: signups24h,
      last7d: signups7d,
      last30d: signups30d,
      pending: pendingSignups,
    },
    ftdByPeriod,
    pnl,
    createdAt: account.created_at.toISOString(),
    additionalCodes: allCodes.map((c) => ({
      id: c.id,
      code: c.code,
      isActive: true,
      createdAt: c.created_at.toISOString(),
    })),
    limits: limits
      ? {
          id: limits.id,
          currencyLimitAmount: toNumber(limits.currency_limit_amount),
          percentageLimit: toNumber(limits.percentage_limit),
          tipLimit: null,
          currencyLimitResetDays: limits.currency_limit_reset_days,
        }
      : null,
    referrals: {
      data: referrals.map((r) => {
        const usage = usageMap.get(r.id);
        return {
          id: r.id,
          referredUserId: r.id,
          referredUsername: r.username ?? null,
          usageType: usage?.lastUsageType ?? "signup",
          depositAmountUsd: usage?.depositAmountUsd ?? 0,
          wagerAmountUsd: usage?.wagerAmountUsd ?? 0,
          referrerCutUsd: usage?.referrerCutUsd ?? 0,
          userBonusUsd: usage?.userBonusUsd ?? 0,
          isFtd: ftdMap.get(r.id) ?? false,
          createdAt: r.created_at.toISOString(),
        };
      }),
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

// ---------------------------------------------------------------------------
// Creator Tips — rain tips sent by this creator
// ---------------------------------------------------------------------------

export async function getCreatorTips(
  userId: string,
  page: number = 1,
  perPage: number = 20,
): Promise<PaginatedResult<CreatorTipItem> & { totalTipped: number }> {
  const [tips, total, totalAgg] = await Promise.all([
    db.rain_tips.findMany({
      where: { user_id: userId },
      include: {
        rains: {
          select: {
            id: true,
            total_pool_usd: true,
            status: true,
            winner_user_id: true,
          },
        },
      },
      orderBy: { created_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    db.rain_tips.count({ where: { user_id: userId } }),
    db.rain_tips.aggregate({
      where: { user_id: userId },
      _sum: { amount_usd: true },
    }),
  ]);

  // Batch-fetch winner usernames
  const winnerIds = [
    ...new Set(
      tips
        .map((t) => t.rains.winner_user_id)
        .filter((id): id is string => id !== null),
    ),
  ];
  const winners =
    winnerIds.length > 0
      ? await db.user.findMany({
          where: { id: { in: winnerIds } },
          select: { id: true, username: true, email: true },
        })
      : [];
  const winnerMap = new Map(
    winners.map((w) => [w.id, w.username ?? w.email ?? w.id.slice(0, 8)]),
  );

  return {
    data: tips.map((t) => ({
      id: t.id,
      rainId: t.rain_id,
      amountUsd: toNumber(t.amount_usd),
      rainTotalPool: toNumber(t.rains.total_pool_usd),
      rainStatus: t.rains.status,
      rainWinnerUsername: t.rains.winner_user_id
        ? winnerMap.get(t.rains.winner_user_id) ?? null
        : null,
      createdAt: t.created_at.toISOString(),
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
    totalTipped: toNumber(totalAgg._sum.amount_usd ?? 0),
  };
}
