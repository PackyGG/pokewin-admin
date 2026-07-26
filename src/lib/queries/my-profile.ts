import { getDrizzleDb } from "@/lib/db";
import { desc, eq, sql } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import {
  admin_users,
  creator_deals,
  creator_socials,
  creator_webhooks,
} from "@/lib/db-schema/admin/schema";
import { toNumber } from "@/lib/utils/decimal";

type AffiliateLevelConfig = { level: number; threshold: unknown };

/**
 * Resolve a creator's affiliate ladder level the same way the rest of the
 * admin panel does (see queries/insights-rewards/affiliate/tier-distribution):
 * the highest `affiliate_level_configs.level` whose `threshold` the creator's
 * lifetime wager volume has crossed. There is no stored level column on
 * `affiliate_accounts` — the level is always derived from wager vs. the config
 * ladder. Falls back to the lowest configured level (or 1) when no threshold is
 * met or no config rows exist.
 */
function resolveAffiliateLevel(
  configs: AffiliateLevelConfig[],
  wagerVolumeUsd: number,
): number {
  let best: { level: number; threshold: number } | null = null;
  for (const c of configs) {
    const threshold = toNumber(c.threshold);
    if (threshold > wagerVolumeUsd) continue;
    if (
      !best ||
      threshold > best.threshold ||
      (threshold === best.threshold && c.level > best.level)
    ) {
      best = { level: c.level, threshold };
    }
  }
  if (best) return best.level;
  const lowest = configs.reduce<number | null>(
    (min, c) => (min === null || c.level < min ? c.level : min),
    null,
  );
  return lowest ?? 1;
}

export async function getMyProfileData(adminUserId: string) {
  const db = await getDrizzleDb();
  // Find the admin user to get email
  const [adminUser] = await adminDrizzle.select({
    email: admin_users.email, username: admin_users.username,
  }).from(admin_users).where(eq(admin_users.id, adminUserId)).limit(1);
  if (!adminUser) return null;

  // Try to find the main site user by email
  const mainUser = (
    await db.execute<{
      id: string;
      username: string | null;
      email: string;
      affiliate_code: string | null;
      affiliate_code_active: boolean | null;
    }>(sql`
      SELECT id, username, email, affiliate_code, affiliate_code_active
      FROM "user"
      WHERE email = ${adminUser.email}
        AND role::text = 'creator'
      LIMIT 1
    `)
  ).rows[0] ?? null;

  // The target_user_id used in admin DB tables
  const targetUserId = mainUser?.id ?? adminUserId;

  // Fetch admin DB data (always available) AND, if a main user is linked,
  // its affiliate/account data — both batches only depend on `targetUserId`,
  // so they can run in one Promise.all instead of being staged.
  const userId = mainUser?.id;
  const [
    webhooks,
    deals,
    socials,
    account,
    referrals,
    payouts,
    clickCount,
    affiliateConfigs,
  ] = await Promise.all([
      adminDrizzle.select().from(creator_webhooks)
        .where(eq(creator_webhooks.target_user_id, targetUserId))
        .orderBy(desc(creator_webhooks.created_at)),
      adminDrizzle.select().from(creator_deals)
        .where(eq(creator_deals.target_user_id, targetUserId))
        .orderBy(desc(creator_deals.created_at)),
      adminDrizzle.select().from(creator_socials)
        .where(eq(creator_socials.target_user_id, targetUserId))
        .orderBy(creator_socials.platform),
      userId
        ? db
            .execute<{
              total_wager_volume_usd: unknown;
              total_earned_usd: unknown;
              available_usd: unknown;
              total_paid_out_usd: unknown;
              total_bonus_distributed_usd: unknown;
              last_payout_at: Date | null;
            }>(sql`
              SELECT
                total_wager_volume_usd,
                total_earned_usd,
                available_usd,
                total_paid_out_usd,
                total_bonus_distributed_usd,
                last_payout_at
              FROM affiliate_accounts
              WHERE user_id = ${userId}
              LIMIT 1
            `)
            .then((result) => result.rows[0] ?? null)
        : Promise.resolve(null),
      userId
        ? db
            .execute<{
              id: string;
              referred_user_id: string;
              referred_username: string | null;
              usage_type: string;
              deposit_amount_usd: unknown;
              wager_amount_usd: unknown;
              referrer_cut_usd: unknown;
              user_bonus_usd: unknown;
              created_at: Date;
            }>(sql`
              SELECT
                acu.id::text AS id,
                acu.referred_user_id,
                referred.username AS referred_username,
                acu.usage_type::text AS usage_type,
                acu.deposit_amount_usd,
                acu.wager_amount_usd,
                acu.referrer_cut_usd,
                acu.user_bonus_usd,
                acu.created_at
              FROM affiliate_code_usages acu
              INNER JOIN "user" referred ON referred.id = acu.referred_user_id
              WHERE acu.affiliate_user_id = ${userId}
              ORDER BY acu.created_at DESC, acu.id DESC
              LIMIT 50
            `)
            .then((result) => result.rows)
        : Promise.resolve(
            [] as Array<{
              id: string;
              referred_user_id: string;
              referred_username: string | null;
              usage_type: string;
              deposit_amount_usd: unknown;
              wager_amount_usd: unknown;
              referrer_cut_usd: unknown;
              user_bonus_usd: unknown;
              created_at: Date;
            }>,
          ),
      userId
        ? db
            .execute<{
              id: string;
              amount_usd: unknown;
              status: string;
              created_at: Date;
            }>(sql`
              SELECT
                id::text AS id,
                amount_usd,
                status::text AS status,
                created_at
              FROM affiliate_payouts
              WHERE affiliate_user_id = ${userId}
              ORDER BY created_at DESC, id DESC
              LIMIT 50
            `)
            .then((result) => result.rows)
        : Promise.resolve(
            [] as Array<{
              id: string;
              amount_usd: unknown;
              status: string;
              created_at: Date;
            }>,
          ),
      mainUser?.affiliate_code
        ? db
            .execute<{ total: string }>(sql`
              SELECT COUNT(*)::text AS total
              FROM affiliate_clicks
              WHERE code = ${mainUser.affiliate_code}
            `)
            .then((result) => Number(result.rows[0]?.total ?? 0))
        : Promise.resolve(0),
      db
        .execute<AffiliateLevelConfig>(sql`
          SELECT level, threshold
          FROM affiliate_level_configs
        `)
        .then((result) => result.rows),
    ]);

  // Affiliate tier is derived, not stored (see resolveAffiliateLevel).
  const affiliateLevel = resolveAffiliateLevel(
    affiliateConfigs,
    account ? toNumber(account.total_wager_volume_usd) : 0,
  );

  // If no main site user, return partial data
  if (!mainUser) {
    return {
      userId: adminUserId,
      username: adminUser.username,
      email: adminUser.email,
      code: "",
      codeActive: false,
      level: affiliateLevel,
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
        id: w.id, url: w.url, type: w.type, enabled: w.enabled, createdAt: new Date(w.created_at).toISOString(),
      })),
      deals: deals.map((d) => ({
        id: d.id, dealName: d.deal_name, dealType: d.deal_type, amount: toNumber(d.amount), currency: d.currency,
        startDate: new Date(d.start_date).toISOString(), endDate: d.end_date ? new Date(d.end_date).toISOString() : null,
        status: d.status, notes: d.notes, createdAt: new Date(d.created_at).toISOString(),
        keepPercentage: toNumber(d.keep_percentage),
        currencyLimitAmount: toNumber(d.currency_limit_amount), currencyLimitResetDays: d.currency_limit_reset_days,
        percentageLimit: toNumber(d.percentage_limit), tipLimit: toNumber(d.tip_limit), tipLimitResetDays: d.tip_limit_reset_days,
        leaderboardPrizePool: toNumber(d.leaderboard_prize_pool), leaderboardOurShare: toNumber(d.leaderboard_our_share),
        leaderboardFrequency: d.leaderboard_frequency, minStreamMinutes: d.min_stream_minutes,
        maxFinancialExposure: toNumber(d.max_financial_exposure),
      })),
      socials: socials.filter((s) => s.username !== "__pending__").map((s) => ({
        id: s.id, platform: s.platform, username: s.username,
        followerCount: s.follower_count, lastFetchedAt: s.last_fetched_at ? new Date(s.last_fetched_at).toISOString() : null,
      })),
    };
  }

  // Full data with main site user (account/referrals/payouts/clickCount
  // already resolved in the parallel batch above).
  return {
    userId: mainUser.id,
    username: mainUser.username,
    email: mainUser.email,
    code: mainUser.affiliate_code ?? "",
    codeActive: mainUser.affiliate_code_active ?? false,
    level: affiliateLevel,
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
      referredUsername: r.referred_username,
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
      id: w.id, url: w.url, type: w.type, enabled: w.enabled, createdAt: new Date(w.created_at).toISOString(),
    })),
    deals: deals.map((d) => ({
      id: d.id, dealName: d.deal_name, dealType: d.deal_type, amount: toNumber(d.amount), currency: d.currency,
      startDate: new Date(d.start_date).toISOString(), endDate: d.end_date ? new Date(d.end_date).toISOString() : null,
      status: d.status, notes: d.notes, createdAt: new Date(d.created_at).toISOString(),
      keepPercentage: toNumber(d.keep_percentage),
      currencyLimitAmount: toNumber(d.currency_limit_amount), currencyLimitResetDays: d.currency_limit_reset_days,
      percentageLimit: toNumber(d.percentage_limit), tipLimit: toNumber(d.tip_limit), tipLimitResetDays: d.tip_limit_reset_days,
      leaderboardPrizePool: toNumber(d.leaderboard_prize_pool), leaderboardOurShare: toNumber(d.leaderboard_our_share),
      leaderboardFrequency: d.leaderboard_frequency, minStreamMinutes: d.min_stream_minutes,
      maxFinancialExposure: toNumber(d.max_financial_exposure),
    })),
    socials: socials.filter((s) => s.username !== "__pending__").map((s) => ({
      id: s.id, platform: s.platform, username: s.username,
      followerCount: s.follower_count, lastFetchedAt: s.last_fetched_at ? new Date(s.last_fetched_at).toISOString() : null,
    })),
  };
}
