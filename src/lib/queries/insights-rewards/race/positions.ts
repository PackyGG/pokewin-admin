import { unstable_cache } from "next/cache";
import { resolveAdminRead } from "@/lib/clickhouse/resolve-read";
import { getRaceInsightsPositionsFromClickHouse } from "@/lib/clickhouse/queries/insights-rewards/race/positions";
import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { toNumber } from "@/lib/utils/decimal";
import {
  daysForInsightsPeriod,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "../_period";

/**
 * Winner-position distribution for the "Positions" tab on
 * /insights/rewards/race.
 *
 * Buckets prize claims by finishing position into five tiers — 1st,
 * 2-3, 4-10, 11-25, 26+. Each bucket carries the count of prize lines
 * + the total USD volume + the average prize. This is a finer grain
 * than the existing `getRaceExtras` 4-bucket spread (which folds 1st
 * into "Top 3"), so the page can answer "what does the top spot pay vs
 * the rest of the podium" without forking the question.
 *
 * Staff + blacklist excluded. Cached per (period × blacklist).
 */

export type RacePositionBucket = {
  label: string;
  count: number;
  volume: number;
  avgPrize: number;
};

async function computePositions(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<RacePositionBucket[]> {
  const db = await getDb();
  const days = daysForInsightsPeriod(period);
  const dateFilter =
    days !== null
      ? `AND rc.claimed_at >= NOW() - INTERVAL '${days} days'`
      : "";
  const blacklistJoin = blacklistNotInClause("u.id", blacklistIds);

  // Single sweep over race_claims — pulls position + prize, then
  // buckets in JS so the SQL stays readable. Volume is small (≤ a few
  // thousand rows even for lifetime sweeps on this surface).
  const rows = await db.$queryRawUnsafe<
    { position: number; prize: string }[]
  >(`
    SELECT
      rc.position::int AS position,
      rc.prize_amount_usd::text AS prize
    FROM race_claims rc
    JOIN "user" u ON u.id = rc.user_id
    WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
      ${dateFilter}
  `);

  const BUCKET_LABELS = ["1st", "2–3", "4–10", "11–25", "26+"];
  const buckets: RacePositionBucket[] = BUCKET_LABELS.map((label) => ({
    label,
    count: 0,
    volume: 0,
    avgPrize: 0,
  }));
  for (const r of rows) {
    const pos = Number(r.position);
    if (!Number.isFinite(pos) || pos <= 0) continue;
    const prize = toNumber(r.prize);
    let idx: number;
    if (pos === 1) idx = 0;
    else if (pos <= 3) idx = 1;
    else if (pos <= 10) idx = 2;
    else if (pos <= 25) idx = 3;
    else idx = 4;
    buckets[idx].count += 1;
    buckets[idx].volume += prize;
  }
  for (const b of buckets) {
    b.avgPrize = b.count > 0 ? b.volume / b.count : 0;
  }
  return buckets;
}

const cachedShort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    resolveAdminRead<RacePositionBucket[]>("insights_race_positions", {
      pg: () => computePositions(period, blacklistIds),
      ch: () => getRaceInsightsPositionsFromClickHouse(period, blacklistIds),
    }),
  ["insights-rewards-race-positions-v1"],
  { revalidate: 60, tags: ["insights-rewards-race"] },
);

const cachedLong = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    resolveAdminRead<RacePositionBucket[]>("insights_race_positions", {
      pg: () => computePositions(period, blacklistIds),
      ch: () => getRaceInsightsPositionsFromClickHouse(period, blacklistIds),
    }),
  ["insights-rewards-race-positions-lifetime-v1"],
  { revalidate: 300, tags: ["insights-rewards-race"] },
);

export async function getRaceInsightsPositions(
  period: InsightsRewardsPeriod,
): Promise<RacePositionBucket[]> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  const ttl = cacheTtlForInsightsPeriod(period);
  return ttl >= 300 ? cachedLong(period, sorted) : cachedShort(period, sorted);
}
