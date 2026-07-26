import { daysAgoFilter, blacklistNotInSql, queryRows, sql } from "@/lib/queries/insights-rewards/_drizzle-query";
import { unstable_cache } from "next/cache";
import { getDrizzleDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { toNumber } from "@/lib/utils/decimal";
import { resolveRainHouseCost } from "@/lib/metrics";
import {
  daysForInsightsPeriodCapped,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "./_period";

/**
 * Stacking analysis — users who claim MULTIPLE reward categories.
 *
 * Categorise each in-window claimant by the count of DISTINCT reward
 * categories they touched. Each band gets:
 *   - userCount        : how many claimants sit in that band
 *   - share            : % of total claimants
 *   - totalRewardCost  : sum of every reward $ paid to users in the band
 *   - totalWager       : sum of gameplay wager from the same users in
 *                        the same window
 *   - avgRewardCost    : per-user reward $
 *   - avgWager         : per-user wager
 *   - avgLtvProxy      : wager − payouts per user (gameplay GGR proxy)
 *
 * Goal: answer "do stackers (users who hit multiple reward types) carry
 * higher in-window LTV than single-category claimants?".
 *
 * Bands: 1 / 2 / 3 / 4+. The 4+ catch-all matches the top tier of
 * combined-bonus engagement we typically see — there are 7 categories
 * total so going much higher would split the band into long-tail rows
 * with single-digit cohort sizes.
 *
 * Top stackers list (separate from the band rollup) — the 10 users with
 * the MOST distinct reward categories claimed in the window, broken
 * ties by total reward $.
 *
 * Wager / payout side use the same ledger types as `getGgrBreakdown` so
 * the LTV proxy lines up with how GGR is measured elsewhere on the
 * platform.
 */

// Canonical reward set. `creator_tip` EXCLUDED (RESIDUAL user→user
// pass-through, $0 net house cost; ledger-sets.ts) so it neither counts
// as a stacking category nor inflates reward $. `rain_tip` included so
// the rain house slice can be netted (`max(0, rain_win − rain_tip)`)
// before folding into the reward total; it is never a category itself.
// Matches the corrected cross-category-summary / category-spend-breakdown.
const ALL_REWARD_TYPES_SQL = `(
  'deposit_bonus','promo_code_redeemed','gift_card_redeemed',
  'rakeback_claim','affiliate_claim',
  'rain_win','rain_tip','race_prize','balance_reward_claim',
  'waitlist_prize'
)`;

const WAGER_TYPES_SQL = `(
  'pack_opening','battle_bet','battle_sponsorship','upgrader_bet'
)`;

const PAYOUT_TYPES_SQL = `('battle_refund','upgrader_payout')`;

export type StackingBand = {
  /** Distinct categories claimed in the window (1 / 2 / 3 / 4+). */
  band: 1 | 2 | 3 | 4;
  label: string;
  userCount: number;
  share: number;
  totalRewardCost: number;
  totalWager: number;
  totalLtvProxy: number;
  avgRewardCost: number;
  avgWager: number;
  avgLtvProxy: number;
};

export type TopStacker = {
  userId: string;
  username: string | null;
  categoryCount: number;
  rewardTotal: number;
  wagerTotal: number;
  ltvProxy: number;
};

export type RewardsStackingAnalysis = {
  bands: StackingBand[];
  totalClaimants: number;
  topStackers: TopStacker[];
  /**
   * Headline: how much average LTV does a 4+ stacker show vs a single-
   * category claimant? Multiplicative, e.g. 2.4 = 2.4x. `null` when
   * either side is empty.
   */
  ltvLift4xVsSingle: number | null;
};

async function computeStackingAnalysis(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<RewardsStackingAnalysis> {
  const db = await getDrizzleDb();
  // Lifetime (`all`) CAPPED to INSIGHTS_LIFETIME_LOOKBACK_DAYS (365d) via
  // daysForInsightsPeriodCapped so the reward/wager/payout sweeps over the
  // full ledger_transactions history never run unbounded (CLAUDE.md
  // "Performance & Daten-Laden"). Finite windows are unchanged; the filter
  // is now always present (capped never returns null).
  const days = daysForInsightsPeriodCapped(period);
  const dateFilter = daysAgoFilter("lt.created_at", days);
  const blacklistJoin = blacklistNotInSql("u.id", blacklistIds);

  // Per-user rollup — collapse claim categories + sum the per-side
  // money in the same CTE. Categories use a single GROUP BY on user_id
  // with FILTER over the CASE-mapped category buckets, so each user
  // gets one row.
  const userRows = await queryRows<
    {
      user_id: string;
      username: string | null;
      categories: string;
      reward_excl_rain: string;
      rain_win: string;
      rain_tip: string;
      wager_total: string;
      payout_total: string;
    }[]
  >(db, sql`
    WITH per_user_categories AS (
      SELECT
        lt.user_id,
        COUNT(DISTINCT CASE
          WHEN lt.type::text IN ('deposit_bonus','promo_code_redeemed','gift_card_redeemed') THEN 'bonuses'
          WHEN lt.type::text = 'rakeback_claim' THEN 'rakeback'
          WHEN lt.type::text = 'affiliate_claim' THEN 'affiliate'
          WHEN lt.type::text IN ('rain_win','race_prize') THEN 'rainRace'
          WHEN lt.type::text = 'balance_reward_claim' THEN 'signupPack'
          WHEN lt.type::text = 'waitlist_prize' THEN 'waitlist'
          -- rain_tip / creator_tip are NOT categories: rain_tip is the
          -- pool FUNDING leg, creator_tip is a RESIDUAL pass-through.
        END)::int AS categories,
        -- Reward $ split so rain can be netted: everything except rain
        -- legs, plus rain_win / rain_tip captured separately.
        COALESCE(SUM(CASE WHEN lt.type::text NOT IN ('rain_win','rain_tip') THEN ABS(lt.amount::numeric) ELSE 0 END), 0) AS reward_excl_rain,
        COALESCE(SUM(CASE WHEN lt.type::text = 'rain_win' THEN ABS(lt.amount::numeric) ELSE 0 END), 0) AS rain_win,
        COALESCE(SUM(CASE WHEN lt.type::text = 'rain_tip' THEN ABS(lt.amount::numeric) ELSE 0 END), 0) AS rain_tip
      FROM ledger_transactions lt
      JOIN "user" u ON u.id = lt.user_id
      WHERE lt.status = 'completed'
        AND lt.type::text IN ${sql.raw(ALL_REWARD_TYPES_SQL)}
        AND u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${dateFilter}
      GROUP BY lt.user_id
    ),
    per_user_wagers AS (
      SELECT
        lt.user_id,
        COALESCE(SUM(ABS(lt.amount::numeric)), 0) AS wager_total
      FROM ledger_transactions lt
      JOIN "user" u ON u.id = lt.user_id
      WHERE lt.status = 'completed'
        AND lt.type::text IN ${sql.raw(WAGER_TYPES_SQL)}
        AND u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${dateFilter}
      GROUP BY lt.user_id
    ),
    per_user_payouts AS (
      SELECT
        lt.user_id,
        COALESCE(SUM(ABS(lt.amount::numeric)), 0) AS payout_total
      FROM ledger_transactions lt
      JOIN "user" u ON u.id = lt.user_id
      WHERE lt.status = 'completed'
        AND lt.type::text IN ${sql.raw(PAYOUT_TYPES_SQL)}
        AND u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${dateFilter}
      GROUP BY lt.user_id
    )
    SELECT
      puc.user_id,
      u.username,
      puc.categories::text AS categories,
      puc.reward_excl_rain::text AS reward_excl_rain,
      puc.rain_win::text AS rain_win,
      puc.rain_tip::text AS rain_tip,
      COALESCE(puw.wager_total, 0)::text AS wager_total,
      COALESCE(pup.payout_total, 0)::text AS payout_total
    FROM per_user_categories puc
    JOIN "user" u ON u.id = puc.user_id
    LEFT JOIN per_user_wagers puw ON puw.user_id = puc.user_id
    LEFT JOIN per_user_payouts pup ON pup.user_id = puc.user_id
  `);

  // Roll up into bands. 4+ catches everything ≥ 4 to keep the table
  // readable; the top-stackers list still surfaces the actual maximum.
  const bandTotals = new Map<
    1 | 2 | 3 | 4,
    {
      userCount: number;
      totalRewardCost: number;
      totalWager: number;
      totalLtvProxy: number;
    }
  >();
  const topStackerInput: TopStacker[] = [];
  for (const r of userRows) {
    const cats = Math.max(1, Number(r.categories));
    // Reward $ = non-rain reward legs + the NET rain house slice
    // (max(0, rain_win − rain_tip)), owner-confirmed — never gross rain.
    const reward =
      toNumber(r.reward_excl_rain) +
      resolveRainHouseCost({
        kind: "net",
        rainWinTotal: toNumber(r.rain_win),
        rainTipTotal: toNumber(r.rain_tip),
      });
    const wager = toNumber(r.wager_total);
    const payout = toNumber(r.payout_total);
    const ltv = wager - payout;
    const band = (cats >= 4 ? 4 : cats) as 1 | 2 | 3 | 4;
    const existing = bandTotals.get(band) ?? {
      userCount: 0,
      totalRewardCost: 0,
      totalWager: 0,
      totalLtvProxy: 0,
    };
    existing.userCount += 1;
    existing.totalRewardCost += reward;
    existing.totalWager += wager;
    existing.totalLtvProxy += ltv;
    bandTotals.set(band, existing);
    topStackerInput.push({
      userId: r.user_id,
      username: r.username,
      categoryCount: cats,
      rewardTotal: reward,
      wagerTotal: wager,
      ltvProxy: ltv,
    });
  }

  const totalClaimants = userRows.length;
  const BAND_LABELS: Record<1 | 2 | 3 | 4, string> = {
    1: "Single-category claimants",
    2: "2 categories",
    3: "3 categories",
    4: "4+ categories (stackers)",
  };
  const bands: StackingBand[] = ([1, 2, 3, 4] as const).map((band) => {
    const totals = bandTotals.get(band) ?? {
      userCount: 0,
      totalRewardCost: 0,
      totalWager: 0,
      totalLtvProxy: 0,
    };
    const avg = (sum: number) =>
      totals.userCount > 0 ? sum / totals.userCount : 0;
    return {
      band,
      label: BAND_LABELS[band],
      userCount: totals.userCount,
      share: totalClaimants > 0 ? (totals.userCount / totalClaimants) * 100 : 0,
      totalRewardCost: totals.totalRewardCost,
      totalWager: totals.totalWager,
      totalLtvProxy: totals.totalLtvProxy,
      avgRewardCost: avg(totals.totalRewardCost),
      avgWager: avg(totals.totalWager),
      avgLtvProxy: avg(totals.totalLtvProxy),
    };
  });

  const singleBand = bands.find((b) => b.band === 1);
  const stackerBand = bands.find((b) => b.band === 4);
  const ltvLift4xVsSingle =
    singleBand && singleBand.avgLtvProxy > 0 && stackerBand
      ? stackerBand.avgLtvProxy / singleBand.avgLtvProxy
      : null;

  // Top 10 stackers — sort by category count DESC then reward total
  // DESC. Tied on both → first id wins (alphabetical), which is fine.
  topStackerInput.sort((a, b) => {
    if (b.categoryCount !== a.categoryCount)
      return b.categoryCount - a.categoryCount;
    return b.rewardTotal - a.rewardTotal;
  });
  const topStackers = topStackerInput.slice(0, 10);

  return {
    bands,
    totalClaimants,
    topStackers,
    ltvLift4xVsSingle,
  };
}

const cachedStackingAnalysis = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeStackingAnalysis(period, blacklistIds),
  ["insights-rewards-stacking-v1"],
  { revalidate: 60, tags: ["rewards-analytics", "insights-rewards"] },
);

const cachedStackingAnalysisLifetime = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeStackingAnalysis(period, blacklistIds),
  ["insights-rewards-stacking-lifetime-v1"],
  { revalidate: 300, tags: ["rewards-analytics", "insights-rewards"] },
);

export async function getRewardsStackingAnalysis(
  period: InsightsRewardsPeriod,
): Promise<RewardsStackingAnalysis> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  const ttl = cacheTtlForInsightsPeriod(period);
  return ttl >= 300
    ? cachedStackingAnalysisLifetime(period, sorted)
    : cachedStackingAnalysis(period, sorted);
}
