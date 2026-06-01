import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { toNumber } from "@/lib/utils/decimal";
import {
  type InsightsRewardsPeriod,
} from "../_period";
import { CACHE_TAG, loadBlacklist, makePeriodCtx } from "./_shared";

/**
 * Repeat-claim cadence per affiliate. Surfaces how often each
 * top affiliate claims their accrued commission within the active
 * window — a useful operational signal for distinguishing:
 *
 *   - high-frequency claimers (multiple small claims, often automated
 *     or used as cash-flow income)
 *   - bulk claimers (one big claim per period — settlement at threshold)
 *   - dormant-then-active spikes (a single claim after long silence —
 *     could be re-activation, could be cash-out)
 *
 * For each top-25 affiliate by claim count in window, we compute:
 *   - claim count in window
 *   - mean gap between consecutive claims (hours)
 *   - median gap between consecutive claims (hours)
 *   - mean / median claim amount
 *
 * Single-claim affiliates show with `meanGapHours = null` since gap
 * is undefined for n=1.
 *
 * Ordered by claim count DESC so the most active claimers float to the
 * top.
 */

const ROW_LIMIT = 25;

export type ClaimCadenceRow = {
  affiliateUserId: string;
  username: string | null;
  /** Number of claim ledger rows in the active window. */
  claimCount: number;
  /** Sum of ABS(amount) across claims in window. */
  totalCommission: number;
  /** Mean claim amount. */
  meanClaimAmount: number;
  /** Median claim amount. */
  medianClaimAmount: number;
  /**
   * Mean gap in hours between consecutive claims. Null when claimCount
   * < 2 (gap undefined).
   */
  meanGapHours: number | null;
  /**
   * Median gap in hours between consecutive claims. Null when
   * claimCount < 2.
   */
  medianGapHours: number | null;
};

async function compute(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<ClaimCadenceRow[]> {
  const db = await getDb();
  const ctx = makePeriodCtx(period);
  const ltDate = ctx.dateFilterFor("lt.created_at");
  const blacklistJoin = blacklistNotInClause("u.id", blacklistIds);

  // LAG over created_at per user → gap between consecutive claims.
  // Then aggregate count / sum / mean / median per affiliate.
  // PERCENTILE_CONT on the gap distribution for median gap.
  const rows = await db.$queryRawUnsafe<
    {
      affiliate_user_id: string;
      username: string | null;
      claim_count: string;
      total_commission: string;
      mean_amount: string;
      median_amount: string | null;
      mean_gap_hours: string | null;
      median_gap_hours: string | null;
    }[]
  >(`
    WITH claim_rows AS (
      SELECT
        lt.user_id,
        ABS(lt.amount::numeric) AS amount,
        lt.created_at,
        EXTRACT(EPOCH FROM (
          lt.created_at - LAG(lt.created_at) OVER (PARTITION BY lt.user_id ORDER BY lt.created_at)
        )) / 3600.0 AS gap_hours
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type = 'affiliate_claim'
        ${ltDate}
    ),
    per_user AS (
      SELECT
        cr.user_id,
        COUNT(*) AS claim_count,
        SUM(cr.amount) AS total_commission,
        AVG(cr.amount) AS mean_amount,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cr.amount) AS median_amount,
        AVG(cr.gap_hours) AS mean_gap_hours,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cr.gap_hours) AS median_gap_hours
      FROM claim_rows cr
      GROUP BY cr.user_id
    )
    SELECT
      pu.user_id AS affiliate_user_id,
      u.username,
      pu.claim_count::text AS claim_count,
      pu.total_commission::text AS total_commission,
      pu.mean_amount::text AS mean_amount,
      pu.median_amount::text AS median_amount,
      pu.mean_gap_hours::text AS mean_gap_hours,
      pu.median_gap_hours::text AS median_gap_hours
    FROM per_user pu
    JOIN "user" u ON u.id = pu.user_id
    WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
    ORDER BY pu.claim_count DESC, pu.total_commission DESC
    LIMIT ${ROW_LIMIT}
  `);

  return rows.map((r) => ({
    affiliateUserId: r.affiliate_user_id,
    username: r.username,
    claimCount: Number(r.claim_count),
    totalCommission: toNumber(r.total_commission),
    meanClaimAmount: toNumber(r.mean_amount),
    medianClaimAmount: r.median_amount != null ? toNumber(r.median_amount) : 0,
    meanGapHours:
      r.mean_gap_hours != null ? toNumber(r.mean_gap_hours) : null,
    medianGapHours:
      r.median_gap_hours != null ? toNumber(r.median_gap_hours) : null,
  }));
}

const cachedShort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    compute(period, blacklistIds),
  ["insights-affiliate-claim-cadence-v1-short"],
  { revalidate: 60, tags: [CACHE_TAG, "rewards-analytics"] },
);
const cachedLong = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    compute(period, blacklistIds),
  ["insights-affiliate-claim-cadence-v1-long"],
  { revalidate: 300, tags: [CACHE_TAG, "rewards-analytics"] },
);

export async function getAffiliateClaimCadence(
  period: InsightsRewardsPeriod,
): Promise<ClaimCadenceRow[]> {
  const blacklist = await loadBlacklist();
  return period === "all"
    ? cachedLong(period, blacklist)
    : cachedShort(period, blacklist);
}
