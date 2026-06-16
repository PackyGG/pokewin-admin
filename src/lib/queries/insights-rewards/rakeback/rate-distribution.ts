import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { toNumber } from "@/lib/utils/decimal";
import {
  daysForInsightsPeriod,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { resolveAdminRead } from "@/lib/clickhouse/resolve-read";
import { getRakebackRateDistributionFromClickHouse } from "@/lib/clickhouse/queries/insights-rewards/rakeback/rate-distribution";

/**
 * "Rakeback as % of wager" cohort lens for the deep stats page.
 *
 * For each CLAIMANT in the window we compute their personal ratio:
 *
 *    userRatio = SUM(rakeback_amount_usd) / SUM(wagered_amount_usd)
 *
 * This is a PER-USER ratio (their lifetime-in-window rakeback over
 * their lifetime-in-window wager-from-claims) — not a per-claim ratio.
 * The page also surfaces the raw per-claim distribution which lives in
 * the shared `RakebackExtras` (`rateBuckets` field). This module's
 * histogram is the cohort lens: how many CLAIMANTS landed in each
 * percent-of-wager bucket.
 *
 * Buckets match the spec: 0–1%, 1–3%, 3–5%, 5–10%, 10%+.
 *
 * Plus headline stats:
 *   - avgPctOfWager     (volume-weighted: SUM(rake)/SUM(wager))
 *   - medianPctOfWager  (median across per-user ratios)
 *   - p95PctOfWager     (95th percentile across per-user ratios)
 *
 * Source: `rakeback_claims`. Staff + blacklist excluded.
 */

export type RakebackRateDistribution = {
  avgPctOfWager: number;
  medianPctOfWager: number;
  p95PctOfWager: number;
  /** Number of claimants in the window with wager > 0. */
  cohortSize: number;
  buckets: Array<{ label: string; count: number; share: number }>;
};

const BUCKET_DEFS = [
  { label: "0–1%", minPct: 0, maxPct: 1 },
  { label: "1–3%", minPct: 1, maxPct: 3 },
  { label: "3–5%", minPct: 3, maxPct: 5 },
  { label: "5–10%", minPct: 5, maxPct: 10 },
  { label: "10%+", minPct: 10, maxPct: Infinity },
] as const;

async function computeRateDistribution(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<RakebackRateDistribution> {
  const db = await getDb();
  const days = daysForInsightsPeriod(period);
  const blacklistJoin = blacklistNotInClause("u.id", blacklistIds);
  const dateFilter =
    days !== null ? `AND rc.claimed_at >= NOW() - INTERVAL '${days} days'` : "";

  // One sweep, per-user aggregate. Filter wager>0 so the ratio is
  // well-defined; claims with zero wagered_amount_usd are config edge
  // cases (manual adjustments) and would skew the cohort.
  const rows = await db.$queryRawUnsafe<
    {
      user_id: string;
      total_rakeback: string;
      total_wager: string;
    }[]
  >(`
    SELECT
      rc.user_id,
      SUM(rc.rakeback_amount_usd::numeric)::text AS total_rakeback,
      SUM(rc.wagered_amount_usd::numeric)::text AS total_wager
    FROM rakeback_claims rc
    JOIN "user" u ON u.id = rc.user_id
    WHERE rc.claimed_at IS NOT NULL
      AND u.role NOT IN ('admin', 'support', 'creator') ${blacklistJoin}
      ${dateFilter}
    GROUP BY rc.user_id
    HAVING SUM(rc.wagered_amount_usd::numeric) > 0
  `);

  let sumRakeback = 0;
  let sumWager = 0;
  const userPcts: number[] = [];
  const buckets = BUCKET_DEFS.map((b) => ({ label: b.label, count: 0 }));

  for (const r of rows) {
    const rake = toNumber(r.total_rakeback);
    const wager = toNumber(r.total_wager);
    sumRakeback += rake;
    sumWager += wager;
    if (wager <= 0) continue;
    const pct = (rake / wager) * 100;
    if (!Number.isFinite(pct) || pct < 0) continue;
    userPcts.push(pct);
    // Bucket assignment — half-open [min, max). `10%+` catches everything
    // ≥ 10 since maxPct is +Infinity.
    let idx = BUCKET_DEFS.length - 1;
    for (let i = 0; i < BUCKET_DEFS.length; i++) {
      if (pct < BUCKET_DEFS[i].maxPct) {
        idx = i;
        break;
      }
    }
    buckets[idx].count += 1;
  }

  userPcts.sort((a, b) => a - b);
  const median =
    userPcts.length === 0
      ? 0
      : userPcts.length % 2 === 1
        ? userPcts[(userPcts.length - 1) / 2]
        : (userPcts[userPcts.length / 2 - 1] +
            userPcts[userPcts.length / 2]) /
          2;
  const p95Idx =
    userPcts.length === 0 ? 0 : Math.min(userPcts.length - 1, Math.floor(0.95 * userPcts.length));
  const p95 = userPcts.length === 0 ? 0 : userPcts[p95Idx];

  const cohortSize = userPcts.length;
  const avgPctOfWager = sumWager > 0 ? (sumRakeback / sumWager) * 100 : 0;

  return {
    avgPctOfWager,
    medianPctOfWager: median,
    p95PctOfWager: p95,
    cohortSize,
    buckets: buckets.map((b) => ({
      label: b.label,
      count: b.count,
      share: cohortSize > 0 ? (b.count / cohortSize) * 100 : 0,
    })),
  };
}

// CQRS serve-path: clickhouse mode serves the CH twin (SOLE read, throws
// through the cache on failure); off/comparison serve Postgres unchanged.
async function resolveRateDistribution(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<RakebackRateDistribution> {
  return resolveAdminRead<RakebackRateDistribution>("insights_rakeback_rate", {
    pg: () => computeRateDistribution(period, blacklistIds),
    ch: () => getRakebackRateDistributionFromClickHouse(period, blacklistIds),
  });
}

const cachedShort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    resolveRateDistribution(period, blacklistIds),
  ["insights-rewards-rakeback-rate-dist-v1"],
  { revalidate: 60, tags: ["rewards-analytics", "insights-rewards-rakeback"] },
);

const cachedLong = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    resolveRateDistribution(period, blacklistIds),
  ["insights-rewards-rakeback-rate-dist-lifetime-v1"],
  { revalidate: 300, tags: ["rewards-analytics", "insights-rewards-rakeback"] },
);

export async function getRakebackRateDistribution(
  period: InsightsRewardsPeriod,
): Promise<RakebackRateDistribution> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  return cacheTtlForInsightsPeriod(period) >= 300
    ? cachedLong(period, sorted)
    : cachedShort(period, sorted);
}
