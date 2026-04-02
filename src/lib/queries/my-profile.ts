import { db } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { toNumber } from "@/lib/utils/decimal";

export async function getMyProfileData(adminUserId: string) {
  // Find the admin user to get email
  const adminUser = await adminDb.admin_users.findUnique({
    where: { id: adminUserId },
    select: { email: true, username: true },
  });
  if (!adminUser) return null;

  // Try to find the main site user by email
  const mainUser = await db.user.findFirst({
    where: { email: adminUser.email, role: "creator" },
    select: { id: true, username: true, email: true, affiliate_code: true, affiliate_code_active: true },
  });

  // The target_user_id used in admin DB tables
  const targetUserId = mainUser?.id ?? adminUserId;

  // Fetch admin DB data (always available)
  const [webhooks, deals, socials] = await Promise.all([
    adminDb.creator_webhooks.findMany({
      where: { target_user_id: targetUserId },
      orderBy: { created_at: "desc" },
    }),
    adminDb.creator_deals.findMany({
      where: { target_user_id: targetUserId },
      orderBy: { created_at: "desc" },
    }),
    adminDb.creator_socials.findMany({
      where: { target_user_id: targetUserId },
      orderBy: { platform: "asc" },
    }),
  ]);

  // If no main site user, return partial data
  if (!mainUser) {
    return {
      userId: adminUserId,
      username: adminUser.username,
      email: adminUser.email,
      code: "",
      codeActive: false,
      level: 1,
      linked: false,
      totalReferred: 0,
      totalWagerVolumeUsd: 0,
      totalEarnedUsd: 0,
      availableUsd: 0,
      totalPaidOutUsd: 0,
      totalBonusDistributedUsd: 0,
      lastPayoutAt: null,
      totalClicks: 0,
      referrals: [],
      payouts: [],
      webhooks: webhooks.map((w) => ({
        id: w.id, url: w.url, type: w.type, enabled: w.enabled, createdAt: w.created_at.toISOString(),
      })),
      deals: deals.map((d) => ({
        id: d.id, dealName: d.deal_name, dealType: d.deal_type, amount: toNumber(d.amount), currency: d.currency,
        startDate: d.start_date.toISOString(), endDate: d.end_date?.toISOString() ?? null,
        status: d.status, notes: d.notes, createdAt: d.created_at.toISOString(),
        dailyFillAmount: toNumber(d.daily_fill_amount), dailyFillTime: d.daily_fill_time, dailyFillEnabled: d.daily_fill_enabled,
        keepPercentage: toNumber(d.keep_percentage),
        currencyLimitAmount: toNumber(d.currency_limit_amount), currencyLimitResetDays: d.currency_limit_reset_days,
        percentageLimit: toNumber(d.percentage_limit), tipLimit: toNumber(d.tip_limit), tipLimitResetDays: d.tip_limit_reset_days,
        leaderboardPrizePool: toNumber(d.leaderboard_prize_pool), leaderboardOurShare: toNumber(d.leaderboard_our_share),
        leaderboardFrequency: d.leaderboard_frequency, minStreamMinutes: d.min_stream_minutes,
        maxFinancialExposure: toNumber(d.max_financial_exposure),
      })),
      socials: socials.filter((s) => s.username !== "__pending__").map((s) => ({
        id: s.id, platform: s.platform, username: s.username,
        followerCount: s.follower_count, lastFetchedAt: s.last_fetched_at?.toISOString() ?? null,
      })),
    };
  }

  // Full data with main site user
  const userId = mainUser.id;

  const [account, referrals, payouts] = await Promise.all([
    db.affiliate_accounts.findUnique({ where: { user_id: userId } }),
    db.affiliate_code_usages.findMany({
      where: { affiliate_user_id: userId },
      include: {
        user_affiliate_code_usages_referred_user_idTouser: {
          select: { username: true },
        },
      },
      orderBy: { created_at: "desc" },
      take: 50,
    }),
    db.affiliate_payouts.findMany({
      where: { affiliate_user_id: userId },
      orderBy: { created_at: "desc" },
      take: 50,
    }),
  ]);

  const clickCount = mainUser.affiliate_code
    ? await db.affiliate_clicks.count({ where: { code: mainUser.affiliate_code } })
    : 0;

  return {
    userId,
    username: mainUser.username,
    email: mainUser.email,
    code: mainUser.affiliate_code ?? "",
    codeActive: mainUser.affiliate_code_active ?? false,
    level: account?.affiliate_level ?? 1,
    linked: true,
    totalReferred: referrals.length,
    totalWagerVolumeUsd: account ? toNumber(account.total_wager_volume_usd) : 0,
    totalEarnedUsd: account ? toNumber(account.total_earned_usd) : 0,
    availableUsd: account ? toNumber(account.available_usd) : 0,
    totalPaidOutUsd: account ? toNumber(account.total_paid_out_usd) : 0,
    totalBonusDistributedUsd: account ? toNumber(account.total_bonus_distributed_usd) : 0,
    lastPayoutAt: account?.last_payout_at?.toISOString() ?? null,
    totalClicks: clickCount,
    referrals: referrals.map((r) => ({
      id: r.id,
      referredUserId: r.referred_user_id,
      referredUsername: r.user_affiliate_code_usages_referred_user_idTouser?.username ?? null,
      usageType: r.usage_type,
      depositAmountUsd: toNumber(r.deposit_amount_usd),
      wagerAmountUsd: toNumber(r.wager_amount_usd),
      referrerCutUsd: toNumber(r.referrer_cut_usd),
      userBonusUsd: toNumber(r.user_bonus_usd),
      createdAt: r.created_at.toISOString(),
    })),
    payouts: payouts.map((p) => ({
      id: p.id,
      amountUsd: toNumber(p.amount_usd),
      status: p.status,
      createdAt: p.created_at.toISOString(),
    })),
    webhooks: webhooks.map((w) => ({
      id: w.id, url: w.url, type: w.type, enabled: w.enabled, createdAt: w.created_at.toISOString(),
    })),
    deals: deals.map((d) => ({
      id: d.id, dealName: d.deal_name, dealType: d.deal_type, amount: toNumber(d.amount), currency: d.currency,
      startDate: d.start_date.toISOString(), endDate: d.end_date?.toISOString() ?? null,
      status: d.status, notes: d.notes, createdAt: d.created_at.toISOString(),
      dailyFillAmount: toNumber(d.daily_fill_amount), dailyFillTime: d.daily_fill_time, dailyFillEnabled: d.daily_fill_enabled,
      keepPercentage: toNumber(d.keep_percentage),
      currencyLimitAmount: toNumber(d.currency_limit_amount), currencyLimitResetDays: d.currency_limit_reset_days,
      percentageLimit: toNumber(d.percentage_limit), tipLimit: toNumber(d.tip_limit), tipLimitResetDays: d.tip_limit_reset_days,
      leaderboardPrizePool: toNumber(d.leaderboard_prize_pool), leaderboardOurShare: toNumber(d.leaderboard_our_share),
      leaderboardFrequency: d.leaderboard_frequency, minStreamMinutes: d.min_stream_minutes,
      maxFinancialExposure: toNumber(d.max_financial_exposure),
    })),
    socials: socials.filter((s) => s.username !== "__pending__").map((s) => ({
      id: s.id, platform: s.platform, username: s.username,
      followerCount: s.follower_count, lastFetchedAt: s.last_fetched_at?.toISOString() ?? null,
    })),
  };
}
