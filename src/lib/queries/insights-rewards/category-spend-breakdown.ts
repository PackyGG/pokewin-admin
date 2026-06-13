import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { toNumber } from "@/lib/utils/decimal";
import { resolveRainHouseCost } from "@/lib/metrics";
import { countedAdjustmentSqlPredicate } from "@/lib/balance-adjustment-categories";
import { realCustomersScopeSql } from "@/lib/queries/insights-games/_shared";
import {
  daysForInsightsPeriodCapped,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "./_period";
import { getDailyPacksGiveaway } from "./daily-packs";

/**
 * Per-category spend breakdown for the Overview tab on /insights/rewards.
 *
 * Categories mirror the CANONICAL reward-cost definition in
 * `src/lib/metrics/queries.ts` `getRewardCost` (the single source of truth;
 * do NOT diverge), so the breakdown reconciles with the cross-category
 * `totalCost` and with /rewards/analytics by construction:
 *
 *   reward cost = Σ|amount| over REWARD_PAYOUT_TYPES EXCLUDING rain_win
 *               + manual-voucher carve-out (`voucher_redeemed` origin manual)
 *               + counted-adjustment carve-out
 *                 (`countedAdjustmentSqlPredicate()`)
 *               + NET rain  max(0, Σ|rain_win| − Σ|rain_tip|)
 *
 * Specifically:
 *   • `affiliate_leaderboard_prize` is INCLUDED in the `affiliate` row
 *     (it is an affiliate-leaderboard cost; previously omitted → the
 *     affiliate line under-counted by the full leaderboard payout).
 *   • Rain is NETTED to its house slice `max(0, Σ|rain_win| − Σ|rain_tip|)`
 *     (owner-confirmed) inside the `rainRace` row, NOT counted gross —
 *     rain is system-automatic and mixed-funded; user/founder tips that
 *     fed the pool were never the house's money.
 *   • A `houseCredits` row carries the manual-voucher + counted-adjustment
 *     carve-outs (admin house-granted vouchers + categorized balance
 *     credits: bonus / giveaway / reload / lossback / deposit-fix). These
 *     are per-ROW metadata splits, not whole ledger types.
 *   • `creator_tip` is NOT a category — it is a verified user→user
 *     pass-through (RESIDUAL), not a house cost (owner decision: creator
 *     costs stay OUT of customer GGR/NGR).
 *   • Non-manual `voucher_redeemed` is NEUTRAL and never appears.
 *   • Any category that is $0 in the window is HIDDEN (general rule — an
 *     empty reward line never clutters the breakdown).
 *
 * SCOPE: real customers only — staff AND creators dropped + blacklist, via
 * `realCustomersScopeSql()` (the canonical customer scope). The previous
 * `role NOT IN ('admin','support')` shape leaked creator reward rows into
 * the customer total.
 *
 * Re-emits the breakdown at the wider /insights/rewards period set
 * (24h / 3d / 7d / 30d / 90d / all) so the page can show a 90d slice —
 * which /rewards/analytics does not expose.
 *
 * Each row carries:
 *   - total       : USD spend for the period (rain netted).
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
  | "waitlist"
  | "houseCredits"
  | "dailyPacks";

const CATEGORY_LABELS: Record<InsightsCategoryKey, string> = {
  bonuses: "Bonuses & Promos",
  rakeback: "Rakeback",
  affiliate: "Affiliate Commissions",
  rainRace: "Rain / Race Prizes",
  signupPack: "Signup / Balance Rewards",
  waitlist: "Waitlist Prizes",
  houseCredits: "House Credits / Vouchers",
  dailyPacks: "Daily / Free Packs",
};

// Canonical reward ledger types this breakdown buckets, PLUS the two
// per-row carve-out source types. `creator_tip` is deliberately omitted
// (a RESIDUAL user→user pass-through, not a house reward cost). `rain_tip`
// is included so the rain house slice can be netted
// (`max(0, rain_win − rain_tip)`); it is never a category of its own (the
// rain FUNDING leg, not a payout). `voucher_redeemed` (manual carve-out
// only) + `admin_balance_adjustment` (counted carve-out only) feed the
// houseCredits row via per-row predicates in the CASE below.
const COUNTED_ADJ_PREDICATE = countedAdjustmentSqlPredicate({
  typeColumn: "lt.type",
  metadataColumn: "lt.metadata",
  amountColumn: "lt.amount",
});
const ALL_REWARD_TYPES_SQL = `(
  'deposit_bonus','promo_code_redeemed','gift_card_redeemed',
  'rakeback_claim','affiliate_claim','affiliate_leaderboard_prize',
  'rain_win','rain_tip','race_prize','balance_reward_claim',
  'waitlist_prize','voucher_redeemed','admin_balance_adjustment'
)`;

// The shared CASE that maps a scanned ledger row to its category bucket
// (or a rain pseudo-bucket / NULL for rows that don't qualify, e.g. a
// non-manual voucher or an uncounted adjustment). Used identically by the
// rollup and the daily-series sweeps so they bucket rows the same way.
const CATEGORY_CASE_SQL = `CASE
  WHEN lt.type::text IN ('deposit_bonus','promo_code_redeemed','gift_card_redeemed') THEN 'bonuses'
  WHEN lt.type::text = 'rakeback_claim' THEN 'rakeback'
  WHEN lt.type::text IN ('affiliate_claim','affiliate_leaderboard_prize') THEN 'affiliate'
  WHEN lt.type::text = 'race_prize' THEN 'rainRace'
  -- rain_win / rain_tip kept as separate pseudo-buckets so the
  -- house slice can be netted (max(0, rain_win − rain_tip)) in JS
  -- before folding into the rainRace row.
  WHEN lt.type::text = 'rain_win' THEN '__rain_win'
  WHEN lt.type::text = 'rain_tip' THEN '__rain_tip'
  WHEN lt.type::text = 'balance_reward_claim' THEN 'signupPack'
  WHEN lt.type::text = 'waitlist_prize' THEN 'waitlist'
  -- House-granted manual vouchers + categorized counted balance credits.
  -- Non-manual vouchers / uncounted adjustments fall through to NULL and
  -- are dropped by the GROUP BY (their bucket key is NULL).
  WHEN lt.type::text = 'voucher_redeemed' AND lt.metadata->>'origin' = 'manual' THEN 'houseCredits'
  WHEN ${COUNTED_ADJ_PREDICATE} THEN 'houseCredits'
END`;

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
  // Lifetime (`all`) CAPPED to INSIGHTS_LIFETIME_LOOKBACK_DAYS (365d) via
  // daysForInsightsPeriodCapped so the per-category ledger rollup + daily
  // series never scan the full ledger unbounded (CLAUDE.md "Performance &
  // Daten-Laden"). Matches the capped cross-category-summary so grandTotal
  // keeps reconciling with its totalCost on the lifetime window too.
  const dateFilter = `AND lt.created_at >= NOW() - INTERVAL '${daysForInsightsPeriodCapped(period)} days'`;
  // Canonical real-customer scope: drop staff + creators + blacklist. The
  // resolved blacklist ids are already baked into the cache key (the
  // wrapper passes a sorted snapshot); realCustomersScopeSql re-reads the
  // request-cached list, returning the same set.
  const customerScope = await realCustomersScopeSql();
  // realCustomersScopeSql returns `(SELECT id FROM "user" u WHERE ...)`,
  // aliasing the subquery row as `u`; `void blacklistIds` keeps the cache
  // key param referenced (it is consumed by getExcludedUserIds inside the
  // helper, but we keep the param so the cache key still varies on it).
  void blacklistIds;

  // Two parallel sweeps (share the SAME category CASE so they bucket rows
  // identically):
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
        ${CATEGORY_CASE_SQL} AS category,
        COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS total,
        COUNT(*)::text AS cnt,
        COUNT(DISTINCT lt.user_id)::text AS claimants
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text IN ${ALL_REWARD_TYPES_SQL}
        AND lt.user_id IN ${customerScope}
        ${dateFilter}
      GROUP BY 1
    `),
    db.$queryRawUnsafe<
      { date: Date; category: string; total: string }[]
    >(`
      SELECT
        DATE(lt.created_at) AS date,
        ${CATEGORY_CASE_SQL} AS category,
        COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS total
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text IN ${ALL_REWARD_TYPES_SQL}
        AND lt.user_id IN ${customerScope}
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
    waitlist: { total: 0, count: 0, claimants: 0 },
    houseCredits: { total: 0, count: 0, claimants: 0 },
    dailyPacks: { total: 0, count: 0, claimants: 0 },
  };
  // Rain legs captured separately so the house slice can be netted
  // (`max(0, rain_win − rain_tip)`) before folding into the rainRace row.
  // The rainRace COUNT / CLAIMANTS reflect the real reward events
  // (race_prize rows + rain_win rows) — the netting is a COST adjustment
  // only, never a claim that rain wins did not happen.
  let rainWinTotal = 0;
  let rainTipTotal = 0;
  let rainWinCount = 0;
  let rainWinClaimants = 0;
  for (const r of rollupRows) {
    if (r.category === "__rain_win") {
      rainWinTotal = toNumber(r.total);
      rainWinCount = Number(r.cnt);
      rainWinClaimants = Number(r.claimants);
      continue;
    }
    if (r.category === "__rain_tip") {
      rainTipTotal = toNumber(r.total);
      continue;
    }
    const key = r.category as InsightsCategoryKey;
    if (!(key in baseTotals)) continue;
    baseTotals[key].total = toNumber(r.total);
    baseTotals[key].count = Number(r.cnt);
    baseTotals[key].claimants = Number(r.claimants);
  }
  // Fold the netted rain house slice into rainRace alongside race_prize.
  // `rainRace` already holds the race_prize totals from the loop above;
  // add the net rain cost + the rain-win event count/claimants.
  baseTotals.rainRace.total += resolveRainHouseCost({
    kind: "net",
    rainWinTotal,
    rainTipTotal,
  });
  baseTotals.rainRace.count += rainWinCount;
  baseTotals.rainRace.claimants += rainWinClaimants;

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
  // the sparkline component handles gaps natively. Rain is netted PER DAY
  // (`max(0, rain_win_day − rain_tip_day)`) before being added to the
  // rainRace day point, mirroring the canonical per-day net-rain model.
  const dailyByCategory: Record<InsightsCategoryKey, Array<{ date: string; total: number }>> = {
    bonuses: [],
    rakeback: [],
    affiliate: [],
    rainRace: [],
    signupPack: [],
    waitlist: [],
    houseCredits: [],
    dailyPacks: [],
  };
  // Per-day rain legs (date → { win, tip }) accumulated separately, then
  // netted into the rainRace daily series below.
  const rainByDate = new Map<string, { win: number; tip: number }>();
  // rainRace race_prize day points keyed by date so the netted rain can be
  // merged into the SAME day's point (race_prize + net rain).
  const rainRaceByDate = new Map<string, number>();
  for (const d of dailyRows) {
    const date = new Date(d.date).toISOString().split("T")[0];
    const total = toNumber(d.total);
    if (d.category === "__rain_win") {
      const e = rainByDate.get(date) ?? { win: 0, tip: 0 };
      e.win += total;
      rainByDate.set(date, e);
      continue;
    }
    if (d.category === "__rain_tip") {
      const e = rainByDate.get(date) ?? { win: 0, tip: 0 };
      e.tip += total;
      rainByDate.set(date, e);
      continue;
    }
    const key = d.category as InsightsCategoryKey;
    if (!(key in dailyByCategory)) continue;
    if (key === "rainRace") {
      // race_prize day point — staged so net rain for the same day can be
      // added before the series is finalized.
      rainRaceByDate.set(date, (rainRaceByDate.get(date) ?? 0) + total);
      continue;
    }
    dailyByCategory[key].push({ date, total });
  }
  // Merge race_prize + per-day net rain into the rainRace daily series.
  // Union both date key spaces so a day with only race_prize, only rain,
  // or both is represented exactly once.
  const rainRaceDates = new Set<string>([
    ...rainRaceByDate.keys(),
    ...rainByDate.keys(),
  ]);
  dailyByCategory.rainRace = [...rainRaceDates]
    .map((date) => {
      const rain = rainByDate.get(date) ?? { win: 0, tip: 0 };
      const netRain = resolveRainHouseCost({
        kind: "net",
        rainWinTotal: rain.win,
        rainTipTotal: rain.tip,
      });
      return { date, total: (rainRaceByDate.get(date) ?? 0) + netRain };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
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
    "waitlist",
    "houseCredits",
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
    // General rule: hide any category with $0 cost in the window so empty
    // reward lines (e.g. Waitlist Prizes when nothing was paid) never
    // clutter the breakdown. Not a special-case — every category is
    // subject to it.
    .filter((row) => row.total > 0)
    .sort((a, b) => b.total - a.total);

  return { rows, grandTotal };
}

const cachedCategorySpendBreakdown = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeCategorySpendBreakdown(period, blacklistIds),
  // -v2: canonical reward-cost alignment (affiliate_leaderboard_prize +
  // manual-voucher/counted-adjustment houseCredits + real-customer scope).
  // Bumped so stale -v1 cache entries can't serve the old (creator-leaked,
  // affiliate-undercounted) numbers.
  ["insights-rewards-category-spend-v2"],
  { revalidate: 60, tags: ["rewards-analytics", "insights-rewards"] },
);

const cachedCategorySpendBreakdownLifetime = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeCategorySpendBreakdown(period, blacklistIds),
  ["insights-rewards-category-spend-lifetime-v2"],
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
