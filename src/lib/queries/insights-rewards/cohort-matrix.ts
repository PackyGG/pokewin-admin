import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { toNumber } from "@/lib/utils/decimal";
import type { InsightsRewardsPeriod } from "./_period";

/**
 * Cohort comparison — signup cohort × reward usage × LTV.
 *
 * Buckets users by signup month (UTC, YYYY-MM) — only the last 12
 * cohort months so the matrix stays bounded and readable. For each
 * cohort the helper reports:
 *
 *   - cohortSize       : distinct users who signed up in that month
 *   - rewardClaimers   : how many of them have claimed at least one
 *                        reward AT ANY TIME after signup
 *   - claimerShare     : rewardClaimers / cohortSize
 *   - avgRewardPerUser : per-user reward $ across the cohort (claimers
 *                        + non-claimers)
 *   - avgLtvPerUser    : per-user lifetime GGR proxy (wager − payouts)
 *                        across the cohort
 *   - claimerLtv       : avg LTV restricted to reward claimers
 *   - nonClaimerLtv    : avg LTV restricted to non-claimers
 *   - liftPct          : (claimerLtv − nonClaimerLtv) / nonClaimerLtv,
 *                        `null` when nonClaimerLtv ≤ 0
 *
 * "All time" is the only relevant frame here — the matrix is about
 * comparing cohorts across the user lifecycle, not point-in-time
 * activity. The active page period is accepted for API symmetry but
 * ignored in the underlying SQL; the cached helper deliberately keys
 * on the constant so the same matrix renders regardless of period
 * selector.
 *
 * PROPOSED (skipped this pass):
 *   - Per-category cohort × usage matrix. We could break the
 *     rewardClaimers column down per reward category — that's a 12×7
 *     table though, hostile on mobile and only marginally more useful
 *     than the per-category tab. Better as a follow-up popover.
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

const COHORT_MONTHS = 12;

export type CohortRow = {
  /** YYYY-MM cohort label (UTC month). */
  cohort: string;
  cohortSize: number;
  rewardClaimers: number;
  claimerShare: number;
  avgRewardPerUser: number;
  avgLtvPerUser: number;
  claimerLtv: number;
  nonClaimerLtv: number;
  /** Multiplicative lift, e.g. 0.25 = +25%. `null` when nonClaimerLtv ≤ 0. */
  liftPct: number | null;
};

export type RewardsCohortMatrix = {
  rows: CohortRow[];
  /** Aggregate across all cohorts surfaced — convenience for headline KPIs. */
  aggregate: {
    cohortSize: number;
    rewardClaimers: number;
    claimerShare: number;
    avgRewardPerUser: number;
    avgLtvPerUser: number;
    claimerLtv: number;
    nonClaimerLtv: number;
    liftPct: number | null;
  };
};

async function computeCohortMatrix(
  blacklistIds: string[],
): Promise<RewardsCohortMatrix> {
  const db = await getDb();
  const blacklistJoin = blacklistNotInClause("u.id", blacklistIds);

  // Per-cohort rollup:
  //   cohort_users   : signup → cohort_month
  //   user_rewards   : sum reward $ per user
  //   user_wager     : sum wager $ per user
  //   user_payout    : sum payout $ per user
  // Final select pivots by cohort_month, computing the per-user means
  // and the claimer / non-claimer split via FILTER. Limits to the most
  // recent 12 months via a DATE_TRUNC filter so older cohorts don't
  // explode the row count.
  const rows = await db.$queryRawUnsafe<
    {
      cohort: Date;
      cohort_size: string;
      claimers: string;
      reward_total: string;
      wager_total: string;
      payout_total: string;
      claimer_ggr: string;
      non_claimer_ggr: string;
      claimer_user_count: string;
      non_claimer_user_count: string;
    }[]
  >(`
    WITH cohort_users AS (
      SELECT
        u.id AS user_id,
        DATE_TRUNC('month', u.created_at) AS cohort_month
      FROM "user" u
      WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
        AND u.created_at >= DATE_TRUNC('month', NOW()) - INTERVAL '${COHORT_MONTHS - 1} months'
    ),
    user_rewards AS (
      SELECT cu.user_id, COALESCE(SUM(ABS(lt.amount::numeric)), 0) AS reward_total
      FROM cohort_users cu
      LEFT JOIN ledger_transactions lt
        ON lt.user_id = cu.user_id
       AND lt.status = 'completed'
       AND lt.type IN ${ALL_REWARD_TYPES_SQL}
      GROUP BY cu.user_id
    ),
    user_wager AS (
      SELECT cu.user_id, COALESCE(SUM(ABS(lt.amount::numeric)), 0) AS wager_total
      FROM cohort_users cu
      LEFT JOIN ledger_transactions lt
        ON lt.user_id = cu.user_id
       AND lt.status = 'completed'
       AND lt.type IN ${WAGER_TYPES_SQL}
      GROUP BY cu.user_id
    ),
    user_payout AS (
      SELECT cu.user_id, COALESCE(SUM(ABS(lt.amount::numeric)), 0) AS payout_total
      FROM cohort_users cu
      LEFT JOIN ledger_transactions lt
        ON lt.user_id = cu.user_id
       AND lt.status = 'completed'
       AND lt.type IN ${PAYOUT_TYPES_SQL}
      GROUP BY cu.user_id
    ),
    per_user AS (
      SELECT
        cu.cohort_month,
        cu.user_id,
        ur.reward_total > 0 AS is_claimer,
        ur.reward_total,
        uw.wager_total - up.payout_total AS ggr
      FROM cohort_users cu
      JOIN user_rewards ur ON ur.user_id = cu.user_id
      JOIN user_wager uw ON uw.user_id = cu.user_id
      JOIN user_payout up ON up.user_id = cu.user_id
    )
    SELECT
      cohort_month AS cohort,
      COUNT(*)::text AS cohort_size,
      COUNT(*) FILTER (WHERE is_claimer)::text AS claimers,
      COALESCE(SUM(reward_total), 0)::text AS reward_total,
      COALESCE(SUM(ggr) FILTER (WHERE is_claimer), 0)::text AS claimer_ggr,
      COALESCE(SUM(ggr) FILTER (WHERE NOT is_claimer), 0)::text AS non_claimer_ggr,
      COALESCE(SUM(GREATEST(ggr, 0)), 0)::text AS wager_total,
      COALESCE(SUM(GREATEST(-ggr, 0)), 0)::text AS payout_total,
      COUNT(*) FILTER (WHERE is_claimer)::text AS claimer_user_count,
      COUNT(*) FILTER (WHERE NOT is_claimer)::text AS non_claimer_user_count
    FROM per_user
    GROUP BY cohort_month
    ORDER BY cohort_month ASC
  `);

  const parsedRows: CohortRow[] = rows.map((r) => {
    const cohortSize = Number(r.cohort_size ?? 0);
    const rewardClaimers = Number(r.claimers ?? 0);
    const rewardTotal = toNumber(r.reward_total);
    const claimerGgr = toNumber(r.claimer_ggr);
    const nonClaimerGgr = toNumber(r.non_claimer_ggr);
    const claimerCount = Number(r.claimer_user_count ?? 0);
    const nonClaimerCount = Number(r.non_claimer_user_count ?? 0);
    const claimerShare =
      cohortSize > 0 ? rewardClaimers / cohortSize : 0;
    const avgRewardPerUser =
      cohortSize > 0 ? rewardTotal / cohortSize : 0;
    const totalLtv = claimerGgr + nonClaimerGgr;
    const avgLtvPerUser = cohortSize > 0 ? totalLtv / cohortSize : 0;
    const claimerLtv =
      claimerCount > 0 ? claimerGgr / claimerCount : 0;
    const nonClaimerLtv =
      nonClaimerCount > 0 ? nonClaimerGgr / nonClaimerCount : 0;
    const liftPct =
      nonClaimerLtv > 0 ? claimerLtv / nonClaimerLtv - 1 : null;
    const cohortDate = new Date(r.cohort);
    const cohort = `${cohortDate.getUTCFullYear()}-${String(
      cohortDate.getUTCMonth() + 1,
    ).padStart(2, "0")}`;
    return {
      cohort,
      cohortSize,
      rewardClaimers,
      claimerShare,
      avgRewardPerUser,
      avgLtvPerUser,
      claimerLtv,
      nonClaimerLtv,
      liftPct,
    };
  });

  // Roll up the aggregate as the SUM-based equivalent across all
  // cohorts surfaced so the headline KPI panel can show a single
  // blended number alongside the per-cohort table.
  const aggregate = parsedRows.reduce(
    (acc, row) => {
      acc.cohortSize += row.cohortSize;
      acc.rewardClaimers += row.rewardClaimers;
      acc.rewardTotal += row.avgRewardPerUser * row.cohortSize;
      acc.totalLtv += row.avgLtvPerUser * row.cohortSize;
      // Reconstruct the per-cut LTV totals using claimer/non-claimer split.
      acc.claimerGgr += row.claimerLtv * row.rewardClaimers;
      acc.nonClaimerGgr +=
        row.nonClaimerLtv * (row.cohortSize - row.rewardClaimers);
      acc.claimerCount += row.rewardClaimers;
      acc.nonClaimerCount += row.cohortSize - row.rewardClaimers;
      return acc;
    },
    {
      cohortSize: 0,
      rewardClaimers: 0,
      rewardTotal: 0,
      totalLtv: 0,
      claimerGgr: 0,
      nonClaimerGgr: 0,
      claimerCount: 0,
      nonClaimerCount: 0,
    },
  );
  const aggClaimerShare =
    aggregate.cohortSize > 0
      ? aggregate.rewardClaimers / aggregate.cohortSize
      : 0;
  const aggAvgRewardPerUser =
    aggregate.cohortSize > 0 ? aggregate.rewardTotal / aggregate.cohortSize : 0;
  const aggAvgLtvPerUser =
    aggregate.cohortSize > 0 ? aggregate.totalLtv / aggregate.cohortSize : 0;
  const aggClaimerLtv =
    aggregate.claimerCount > 0
      ? aggregate.claimerGgr / aggregate.claimerCount
      : 0;
  const aggNonClaimerLtv =
    aggregate.nonClaimerCount > 0
      ? aggregate.nonClaimerGgr / aggregate.nonClaimerCount
      : 0;
  const aggLiftPct =
    aggNonClaimerLtv > 0 ? aggClaimerLtv / aggNonClaimerLtv - 1 : null;

  return {
    rows: parsedRows,
    aggregate: {
      cohortSize: aggregate.cohortSize,
      rewardClaimers: aggregate.rewardClaimers,
      claimerShare: aggClaimerShare,
      avgRewardPerUser: aggAvgRewardPerUser,
      avgLtvPerUser: aggAvgLtvPerUser,
      claimerLtv: aggClaimerLtv,
      nonClaimerLtv: aggNonClaimerLtv,
      liftPct: aggLiftPct,
    },
  };
}

// Cohort matrix is period-agnostic so a single cache TTL fits. 5m so
// the heavier cohort sweep doesn't refire on every scroll, but stays
// fresh enough that adding a new user surfaces in the current month
// within minutes.
const cachedCohortMatrix = unstable_cache(
  async (blacklistIds: string[]) => computeCohortMatrix(blacklistIds),
  ["insights-rewards-cohort-matrix-v1"],
  { revalidate: 300, tags: ["rewards-analytics", "insights-rewards"] },
);

export async function getRewardsCohortMatrix(
  _period: InsightsRewardsPeriod,
): Promise<RewardsCohortMatrix> {
  // Intentionally ignore the period arg — the cohort matrix is
  // lifetime by construction. The arg is accepted so callers can pass
  // the active page period without conditionals.
  void _period;
  const blacklist = await getExcludedUserIds();
  return cachedCohortMatrix([...blacklist].sort());
}
