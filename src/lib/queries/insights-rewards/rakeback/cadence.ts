import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import {
  daysForInsightsPeriod,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";

/**
 * Claim cadence distribution — gap-between-claims histogram per user.
 *
 * For every (user, claim) pair we compute the gap in hours since the
 * user's previous claim (server-side via LAG). Distribution is then
 * bucketed in JS into:
 *
 *   < 1h, 1–24h, 1–7d, 7d+
 *
 * Plus avg-claims-per-active-user (count / distinct claimants) and the
 * median gap across all gap rows.
 *
 * Source: `rakeback_claims`. Staff + blacklist excluded.
 */

export type RakebackCadence = {
  /** Total claims in window — denominator of "avg per user". */
  totalClaims: number;
  /** Distinct claimants — divisor for avgClaimsPerActiveUser. */
  distinctClaimants: number;
  /** totalClaims / distinctClaimants, 0 when empty. */
  avgClaimsPerActiveUser: number;
  /** Median gap (hours) across gap rows. 0 when no qualifying user. */
  medianGapHours: number;
  /** Histogram of per-gap rows. */
  buckets: Array<{ label: string; count: number; share: number }>;
};

const BUCKET_DEFS = [
  { label: "< 1h", minH: 0, maxH: 1 },
  { label: "1–24h", minH: 1, maxH: 24 },
  { label: "1–7d", minH: 24, maxH: 24 * 7 },
  { label: "7d+", minH: 24 * 7, maxH: Infinity },
] as const;

async function computeCadence(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<RakebackCadence> {
  const db = await getDb();
  const days = daysForInsightsPeriod(period);
  const blacklistJoin = blacklistNotInClause("u.id", blacklistIds);
  const dateFilter =
    days !== null ? `AND rc.claimed_at >= NOW() - INTERVAL '${days} days'` : "";

  // Headline aggregates — total claims + distinct claimants in window.
  const headlineRows = await db.$queryRawUnsafe<
    { cnt: string; distinct_users: string }[]
  >(`
    SELECT
      COUNT(*)::text AS cnt,
      COUNT(DISTINCT rc.user_id)::text AS distinct_users
    FROM rakeback_claims rc
    JOIN "user" u ON u.id = rc.user_id
    WHERE rc.claimed_at IS NOT NULL
      AND u.role NOT IN ('admin', 'support', 'creator') ${blacklistJoin}
      ${dateFilter}
  `);
  const totalClaims = Number(headlineRows[0]?.cnt ?? 0);
  const distinctClaimants = Number(headlineRows[0]?.distinct_users ?? 0);
  const avgClaimsPerActiveUser =
    distinctClaimants > 0 ? totalClaims / distinctClaimants : 0;

  // Per-gap rows — LAG over user-partitioned claimed_at timeline.
  // Each row is one (user, consecutive-claim) gap in hours. Filters
  // prev_claim IS NOT NULL so the first claim per user contributes no
  // row (no gap defined).
  const gapRows = await db.$queryRawUnsafe<{ gap_h: string }[]>(`
    WITH ordered AS (
      SELECT
        rc.user_id,
        rc.claimed_at,
        LAG(rc.claimed_at) OVER (PARTITION BY rc.user_id ORDER BY rc.claimed_at) AS prev_claim
      FROM rakeback_claims rc
      JOIN "user" u ON u.id = rc.user_id
      WHERE rc.claimed_at IS NOT NULL
        AND u.role NOT IN ('admin', 'support', 'creator') ${blacklistJoin}
        ${dateFilter}
    )
    SELECT EXTRACT(EPOCH FROM (claimed_at - prev_claim)) / 3600 AS gap_h
    FROM ordered
    WHERE prev_claim IS NOT NULL
  `);

  const gaps = gapRows
    .map((r) => Number(r.gap_h))
    .filter((h) => Number.isFinite(h) && h >= 0)
    .sort((a, b) => a - b);
  const medianGapHours =
    gaps.length === 0
      ? 0
      : gaps.length % 2 === 1
        ? gaps[(gaps.length - 1) / 2]
        : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2;

  const buckets = BUCKET_DEFS.map((b) => ({ label: b.label, count: 0 }));
  for (const h of gaps) {
    let idx = BUCKET_DEFS.length - 1;
    for (let i = 0; i < BUCKET_DEFS.length; i++) {
      if (h < BUCKET_DEFS[i].maxH) {
        idx = i;
        break;
      }
    }
    buckets[idx].count += 1;
  }
  const totalGapRows = gaps.length;

  return {
    totalClaims,
    distinctClaimants,
    avgClaimsPerActiveUser,
    medianGapHours,
    buckets: buckets.map((b) => ({
      label: b.label,
      count: b.count,
      share: totalGapRows > 0 ? (b.count / totalGapRows) * 100 : 0,
    })),
  };
}

const cachedShort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeCadence(period, blacklistIds),
  ["insights-rewards-rakeback-cadence-v1"],
  { revalidate: 60, tags: ["rewards-analytics", "insights-rewards-rakeback"] },
);

const cachedLong = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeCadence(period, blacklistIds),
  ["insights-rewards-rakeback-cadence-lifetime-v1"],
  { revalidate: 300, tags: ["rewards-analytics", "insights-rewards-rakeback"] },
);

export async function getRakebackCadence(
  period: InsightsRewardsPeriod,
): Promise<RakebackCadence> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  return cacheTtlForInsightsPeriod(period) >= 300
    ? cachedLong(period, sorted)
    : cachedShort(period, sorted);
}
