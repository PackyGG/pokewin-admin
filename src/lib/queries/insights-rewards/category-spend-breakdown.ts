import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { toNumber } from "@/lib/utils/decimal";
import {
  daysForInsightsPeriod,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "./_period";
import { getDailyPacksGiveaway } from "./daily-packs";

/**
 * Per-category spend breakdown for the Overview tab on /insights/rewards.
 *
 * Same category bucketing as `rewards-analytics.ts` so the per-category
 * tabs on this page reconcile with the Overview breakdown rows by
 * construction. Re-emits the breakdown at the wider /insights/rewards
 * period set (24h / 3d / 7d / 30d / 90d / all) so the page can show
 * 90d slice — which /rewards/analytics does not expose.
 *
 * Each row carries:
 *   - total       : USD spend for the period.
 *   - count       : ledger row count.
 *   - claimants   : distinct claimant count.
 *   - share       : % of total cost across all categories.
 *   - dailySeries : daily volume points for the in-page sparkline.
 */

export type InsightsCategoryKey =
  | "bonuses"
  | "rakeback"
  | "affiliate"
  | "rainRace"
  | "signupPack"
  | "creatorTip"
  | "waitlist"
  | "dailyPacks";

const CATEGORY_LABELS: Record<InsightsCategoryKey, string> = {
  bonuses: "Bonuses & Promos",
  rakeback: "Rakeback",
  affiliate: "Affiliate Commissions",
  rainRace: "Rain / Race Prizes",
  signupPack: "Signup / Balance Rewards",
  creatorTip: "Creator Tips",
  waitlist: "Waitlist Prizes",
  dailyPacks: "Daily / Free Packs",
};

// Sentinel — every reward ledger type the platform tracks. Vouchers
// deliberately omitted (separate view).
const ALL_REWARD_TYPES_SQL = `(
  'deposit_bonus','promo_code_redeemed','gift_card_redeemed',
  'rakeback_claim','affiliate_claim',
  'rain_win','race_prize','balance_reward_claim','creator_tip',
  'waitlist_prize'
)`;

export type CategorySpendRow = {
  key: InsightsCategoryKey;
  label: string;
  total: number;
  count: number;
  claimants: number;
  share: number;
  dailySeries: Array<{ date: string; total: number }>;
};

export type CategorySpendBreakdown = {
  rows: CategorySpendRow[];
  /** Sum of all category totals — should equal Cross Summary `totalCost`. */
  grandTotal: number;
};

async function computeCategorySpendBreakdown(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<CategorySpendBreakdown> {
  const db = await getDb();
  const days = daysForInsightsPeriod(period);
  const dateFilter =
    days !== null ? `AND lt.created_at >= NOW() - INTERVAL '${days} days'` : "";
  const blacklistSubquery = blacklistNotInClause("id", blacklistIds);

  // Two parallel sweeps:
  //   1. Per-category rollup — total / count / distinct claimants.
  //   2. Daily series per category — drives the per-row sparkline on
  //      the breakdown panel + the per-category cost-over-time chart
  //      on the Overview tab.
  const [rollupRows, dailyRows] = await Promise.all([
    db.$queryRawUnsafe<
      {
        category: string;
        total: string;
        cnt: string;
        claimants: string;
      }[]
    >(`
      SELECT
        CASE
          WHEN lt.type IN ('deposit_bonus','promo_code_redeemed','gift_card_redeemed') THEN 'bonuses'
          WHEN lt.type = 'rakeback_claim' THEN 'rakeback'
          WHEN lt.type = 'affiliate_claim' THEN 'affiliate'
          WHEN lt.type IN ('rain_win','race_prize') THEN 'rainRace'
          WHEN lt.type = 'balance_reward_claim' THEN 'signupPack'
          WHEN lt.type = 'creator_tip' THEN 'creatorTip'
          WHEN lt.type = 'waitlist_prize' THEN 'waitlist'
        END AS category,
        COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS total,
        COUNT(*)::text AS cnt,
        COUNT(DISTINCT lt.user_id)::text AS claimants
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type IN ${ALL_REWARD_TYPES_SQL}
        AND lt.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${blacklistSubquery})
        ${dateFilter}
      GROUP BY 1
    `),
    db.$queryRawUnsafe<
      { date: Date; category: string; total: string }[]
    >(`
      SELECT
        DATE(lt.created_at) AS date,
        CASE
          WHEN lt.type IN ('deposit_bonus','promo_code_redeemed','gift_card_redeemed') THEN 'bonuses'
          WHEN lt.type = 'rakeback_claim' THEN 'rakeback'
          WHEN lt.type = 'affiliate_claim' THEN 'affiliate'
          WHEN lt.type IN ('rain_win','race_prize') THEN 'rainRace'
          WHEN lt.type = 'balance_reward_claim' THEN 'signupPack'
          WHEN lt.type = 'creator_tip' THEN 'creatorTip'
          WHEN lt.type = 'waitlist_prize' THEN 'waitlist'
        END AS category,
        COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS total
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type IN ${ALL_REWARD_TYPES_SQL}
        AND lt.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${blacklistSubquery})
        ${dateFilter}
      GROUP BY 1, 2
      ORDER BY 1 ASC
    `),
  ]);

  const baseTotals: Record<
    InsightsCategoryKey,
    { total: number; count: number; claimants: number }
  > = {
    bonuses: { total: 0, count: 0, claimants: 0 },
    rakeback: { total: 0, count: 0, claimants: 0 },
    affiliate: { total: 0, count: 0, claimants: 0 },
    rainRace: { total: 0, count: 0, claimants: 0 },
    signupPack: { total: 0, count: 0, claimants: 0 },
    creatorTip: { total: 0, count: 0, claimants: 0 },
    waitlist: { total: 0, count: 0, claimants: 0 },
    dailyPacks: { total: 0, count: 0, claimants: 0 },
  };
  for (const r of rollupRows) {
    const key = r.category as InsightsCategoryKey;
    if (!(key in baseTotals)) continue;
    baseTotals[key].total = toNumber(r.total);
    baseTotals[key].count = Number(r.cnt);
    baseTotals[key].claimants = Number(r.claimants);
  }

  // Daily / free packs are an inventory-based giveaway (no ledger row),
  // so they come from the dedicated `daily-packs` query rather than the
  // ledger sweep above. `total` is the value of cards handed out (the
  // giveaway cost — same basis the cross-category summary folds into
  // `totalCost`, so `grandTotal` here stays equal to it); `count` is the
  // number of opens (one giveaway payout event each); `claimants` is the
  // distinct daily-pack openers.
  const dailyPacks = await getDailyPacksGiveaway(period);
  baseTotals.dailyPacks.total = dailyPacks.giveawayPayout;
  baseTotals.dailyPacks.count = dailyPacks.opens;
  baseTotals.dailyPacks.claimants = dailyPacks.claimers;

  // Bucket the daily series per category. Empty days stay empty —
  // the sparkline component handles gaps natively.
  const dailyByCategory: Record<InsightsCategoryKey, Array<{ date: string; total: number }>> = {
    bonuses: [],
    rakeback: [],
    affiliate: [],
    rainRace: [],
    signupPack: [],
    creatorTip: [],
    waitlist: [],
    dailyPacks: [],
  };
  for (const d of dailyRows) {
    const key = d.category as InsightsCategoryKey;
    if (!(key in dailyByCategory)) continue;
    dailyByCategory[key].push({
      date: new Date(d.date).toISOString().split("T")[0],
      total: toNumber(d.total),
    });
  }
  // Daily-pack giveaway series already comes back date-bucketed
  // (ascending) from the dedicated query.
  dailyByCategory.dailyPacks = dailyPacks.dailySeries;

  const grandTotal = Object.values(baseTotals).reduce(
    (a, b) => a + b.total,
    0,
  );

  const orderedKeys: InsightsCategoryKey[] = [
    "bonuses",
    "rakeback",
    "affiliate",
    "rainRace",
    "signupPack",
    "creatorTip",
    "waitlist",
    "dailyPacks",
  ];
  const rows: CategorySpendRow[] = orderedKeys
    .map((key) => ({
      key,
      label: CATEGORY_LABELS[key],
      total: baseTotals[key].total,
      count: baseTotals[key].count,
      claimants: baseTotals[key].claimants,
      share: grandTotal > 0 ? (baseTotals[key].total / grandTotal) * 100 : 0,
      dailySeries: dailyByCategory[key],
    }))
    .sort((a, b) => b.total - a.total);

  return { rows, grandTotal };
}

const cachedCategorySpendBreakdown = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeCategorySpendBreakdown(period, blacklistIds),
  ["insights-rewards-category-spend-v1"],
  { revalidate: 60, tags: ["rewards-analytics", "insights-rewards"] },
);

const cachedCategorySpendBreakdownLifetime = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeCategorySpendBreakdown(period, blacklistIds),
  ["insights-rewards-category-spend-lifetime-v1"],
  { revalidate: 300, tags: ["rewards-analytics", "insights-rewards"] },
);

export async function getRewardsCategorySpendBreakdown(
  period: InsightsRewardsPeriod,
): Promise<CategorySpendBreakdown> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  const ttl = cacheTtlForInsightsPeriod(period);
  return ttl >= 300
    ? cachedCategorySpendBreakdownLifetime(period, sorted)
    : cachedCategorySpendBreakdown(period, sorted);
}
