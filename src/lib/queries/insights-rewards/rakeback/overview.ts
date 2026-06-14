import { getDb } from "@/lib/db";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { toNumber } from "@/lib/utils/decimal";
import {
  daysForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { makeCachedPair } from "@/lib/queries/insights-rewards/_cache";
import { RAKEBACK_CACHE_TAGS } from "@/lib/queries/insights-rewards/rakeback/_cache-tags";

/**
 * Rakeback overview headline numbers for /insights/rewards/rakeback.
 *
 * Source of truth: `rakeback_claims` (NOT `ledger_transactions`) — the
 * dedicated table carries `wagered_amount_usd` AND `rakeback_amount_usd`
 * per row so % of wager + per-claim ratios are direct, no expensive
 * wager-ledger sweep needed.
 *
 * Returns:
 *   - total rakeback paid in window + claim count + distinct claimants
 *   - total wager attributed to those claims
 *   - period-over-period delta vs the prior-equal window (null for "all")
 *
 * Customer scope (staff + creators + blacklist excluded — the canonical
 * `getMetricsScope()` population) so the headline matches the cohort lens on
 * /insights/rewards and /rewards/analytics (rakeback tab) AND the
 * instant-claim view (which already uses the same creator-excluding scope).
 */

export type RakebackOverview = {
  /** Sum of rakeback_amount_usd in window. */
  totalRakeback: number;
  /** Row count in window. */
  count: number;
  /** Distinct claimants in window. */
  distinctClaimants: number;
  /** Sum of wagered_amount_usd attached to claims in window. */
  totalWager: number;
  /** Avg per claim = totalRakeback / count. */
  avgPerClaim: number;
  /** Largest single rakeback amount in window. */
  largestClaim: number;
  /**
   * Period-over-period delta vs the prior-equal window. `null` for
   * lifetime — no prior frame defined. Fractions (-1.0 to +∞), e.g.
   * 0.25 = +25% vs prior.
   */
  priorWindow: {
    totalRakeback: number;
    count: number;
    distinctClaimants: number;
    rakebackDelta: number | null;
    countDelta: number | null;
    claimantDelta: number | null;
  } | null;
};

async function computeOverview(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<RakebackOverview> {
  const db = await getDb();
  const days = daysForInsightsPeriod(period);
  const blacklistJoin = blacklistNotInClause("u.id", blacklistIds);
  const currentDateClause =
    days !== null
      ? `AND rc.claimed_at >= NOW() - INTERVAL '${days} days'`
      : "";

  const currentRows = await db.$queryRawUnsafe<
    {
      total_rakeback: string;
      cnt: string;
      distinct_users: string;
      total_wager: string;
      largest: string | null;
    }[]
  >(`
    SELECT
      COALESCE(SUM(rc.rakeback_amount_usd::numeric), 0)::text AS total_rakeback,
      COUNT(*)::text AS cnt,
      COUNT(DISTINCT rc.user_id)::text AS distinct_users,
      COALESCE(SUM(rc.wagered_amount_usd::numeric), 0)::text AS total_wager,
      MAX(rc.rakeback_amount_usd::numeric)::text AS largest
    FROM rakeback_claims rc
    JOIN "user" u ON u.id = rc.user_id
    WHERE rc.claimed_at IS NOT NULL
      AND u.role NOT IN ('admin', 'support', 'creator') ${blacklistJoin}
      ${currentDateClause}
  `);
  const cur = currentRows[0];
  const totalRakeback = toNumber(cur?.total_rakeback);
  const count = Number(cur?.cnt ?? 0);
  const distinctClaimants = Number(cur?.distinct_users ?? 0);
  const totalWager = toNumber(cur?.total_wager);
  const largestClaim = cur?.largest != null ? toNumber(cur.largest) : 0;
  const avgPerClaim = count > 0 ? totalRakeback / count : 0;

  let priorWindow: RakebackOverview["priorWindow"] = null;
  if (days !== null) {
    const priorDateClause = `AND rc.claimed_at >= NOW() - INTERVAL '${days * 2} days' AND rc.claimed_at < NOW() - INTERVAL '${days} days'`;
    const priorRows = await db.$queryRawUnsafe<
      {
        total_rakeback: string;
        cnt: string;
        distinct_users: string;
      }[]
    >(`
      SELECT
        COALESCE(SUM(rc.rakeback_amount_usd::numeric), 0)::text AS total_rakeback,
        COUNT(*)::text AS cnt,
        COUNT(DISTINCT rc.user_id)::text AS distinct_users
      FROM rakeback_claims rc
      JOIN "user" u ON u.id = rc.user_id
      WHERE rc.claimed_at IS NOT NULL
        AND u.role NOT IN ('admin', 'support', 'creator') ${blacklistJoin}
        ${priorDateClause}
    `);
    const prev = priorRows[0];
    const prevRakeback = toNumber(prev?.total_rakeback);
    const prevCount = Number(prev?.cnt ?? 0);
    const prevClaimants = Number(prev?.distinct_users ?? 0);
    const delta = (now: number, prev: number): number | null =>
      prev > 0 ? (now - prev) / prev : null;
    priorWindow = {
      totalRakeback: prevRakeback,
      count: prevCount,
      distinctClaimants: prevClaimants,
      rakebackDelta: delta(totalRakeback, prevRakeback),
      countDelta: delta(count, prevCount),
      claimantDelta: delta(distinctClaimants, prevClaimants),
    };
  }

  return {
    totalRakeback,
    count,
    distinctClaimants,
    totalWager,
    avgPerClaim,
    largestClaim,
    priorWindow,
  };
}

// Shared 60s/300s `(period,blacklist)`-keyed cache pair (short for finite
// windows that change as new claims land, long for the lifetime sweep that
// barely moves). Behaviour identical to the hand-rolled pair this replaces.
export const getRakebackOverview = makeCachedPair(
  computeOverview,
  "insights-rewards-rakeback-overview",
  RAKEBACK_CACHE_TAGS,
);
