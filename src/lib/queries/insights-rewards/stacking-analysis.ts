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

const ALL_REWARD_TYPES_SQL = `(
  'deposit_bonus','promo_code_redeemed','gift_card_redeemed',
  'rakeback_claim','affiliate_claim',
  'rain_win','race_prize','balance_reward_claim','creator_tip',
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
  const db = await getDb();
  const days = daysForInsightsPeriod(period);
  const dateFilter =
    days !== null ? `AND lt.created_at >= NOW() - INTERVAL '${days} days'` : "";
  const blacklistJoin = blacklistNotInClause("u.id", blacklistIds);

  // Per-user rollup — collapse claim categories + sum the per-side
  // money in the same CTE. Categories use a single GROUP BY on user_id
  // with FILTER over the CASE-mapped category buckets, so each user
  // gets one row.
  const userRows = await db.$queryRawUnsafe<
    {
      user_id: string;
      username: string | null;
      categories: string;
      reward_total: string;
      wager_total: string;
      payout_total: string;
    }[]
  >(`
    WITH per_user_categories AS (
      SELECT
        lt.user_id,
        COUNT(DISTINCT CASE
          WHEN lt.type IN ('deposit_bonus','promo_code_redeemed','gift_card_redeemed') THEN 'bonuses'
          WHEN lt.type = 'rakeback_claim' THEN 'rakeback'
          WHEN lt.type = 'affiliate_claim' THEN 'affiliate'
          WHEN lt.type IN ('rain_win','race_prize') THEN 'rainRace'
          WHEN lt.type = 'balance_reward_claim' THEN 'signupPack'
          WHEN lt.type = 'creator_tip' THEN 'creatorTip'
          WHEN lt.type = 'waitlist_prize' THEN 'waitlist'
        END)::int AS categories,
        COALESCE(SUM(ABS(lt.amount::numeric)), 0) AS reward_total
      FROM ledger_transactions lt
      JOIN "user" u ON u.id = lt.user_id
      WHERE lt.status = 'completed'
        AND lt.type IN ${ALL_REWARD_TYPES_SQL}
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
        AND lt.type IN ${WAGER_TYPES_SQL}
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
        AND lt.type IN ${PAYOUT_TYPES_SQL}
        AND u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${dateFilter}
      GROUP BY lt.user_id
    )
    SELECT
      puc.user_id,
      u.username,
      puc.categories::text AS categories,
      puc.reward_total::text AS reward_total,
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
    const reward = toNumber(r.reward_total);
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
