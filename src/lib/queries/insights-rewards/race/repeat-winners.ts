import { unstable_cache } from "next/cache";
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
 * Repeat winners detail for /insights/rewards/race.
 *
 * Returns:
 *   - totalRepeatWinners — distinct users with > 1 race-claim instance
 *                          in window
 *   - topRepeatWinners   — top 10 by cumulative prize
 *   - frequencyBuckets   — distribution by race-count
 *                          (2 races / 3 / 4-5 / 6-10 / 11+)
 *
 * Each row carries the user, race count, cumulative prize, and average
 * prize per race. Staff + blacklist excluded.
 */

export type RaceRepeatWinner = {
  userId: string;
  username: string | null;
  raceCount: number;
  totalPrize: number;
  avgPrize: number;
};

export type RaceRepeatFrequencyBucket = {
  label: string;
  userCount: number;
  totalPrize: number;
};

export type RaceRepeatWinnersResult = {
  totalRepeatWinners: number;
  topRepeatWinners: RaceRepeatWinner[];
  frequencyBuckets: RaceRepeatFrequencyBucket[];
};

async function computeRepeatWinners(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<RaceRepeatWinnersResult> {
  const db = await getDb();
  const days = daysForInsightsPeriod(period);
  const dateFilter =
    days !== null
      ? `AND rc.claimed_at >= NOW() - INTERVAL '${days} days'`
      : "";
  const blacklistJoin = blacklistNotInClause("u.id", blacklistIds);

  // One sweep over race_claims grouped by user → per-user race count +
  // total prize. We then filter for races > 1 in JS for the buckets +
  // pull top 10 server-side to keep the payload small.
  const [topRows, allRows] = await Promise.all([
    db.$queryRawUnsafe<
      {
        user_id: string;
        username: string | null;
        race_count: string;
        total_prize: string;
      }[]
    >(`
      WITH per_user AS (
        SELECT
          rc.user_id,
          COUNT(DISTINCT (rc.race_type, rc.race_period_start))::int AS race_count,
          SUM(rc.prize_amount_usd::numeric) AS total_prize
        FROM race_claims rc
        JOIN "user" u ON u.id = rc.user_id
        WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
          ${dateFilter}
        GROUP BY rc.user_id
        HAVING COUNT(DISTINCT (rc.race_type, rc.race_period_start)) > 1
      )
      SELECT
        pu.user_id,
        u.username,
        pu.race_count::text AS race_count,
        pu.total_prize::text AS total_prize
      FROM per_user pu
      JOIN "user" u ON u.id = pu.user_id
      ORDER BY pu.total_prize DESC
      LIMIT 10
    `),
    db.$queryRawUnsafe<{ race_count: string; total_prize: string }[]>(`
      SELECT
        COUNT(DISTINCT (rc.race_type, rc.race_period_start))::int::text AS race_count,
        SUM(rc.prize_amount_usd::numeric)::text AS total_prize
      FROM race_claims rc
      JOIN "user" u ON u.id = rc.user_id
      WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${dateFilter}
      GROUP BY rc.user_id
      HAVING COUNT(DISTINCT (rc.race_type, rc.race_period_start)) > 1
    `),
  ]);

  const topRepeatWinners: RaceRepeatWinner[] = topRows.map((r) => {
    const raceCount = Number(r.race_count ?? 0);
    const totalPrize = toNumber(r.total_prize);
    return {
      userId: r.user_id,
      username: r.username,
      raceCount,
      totalPrize,
      avgPrize: raceCount > 0 ? totalPrize / raceCount : 0,
    };
  });

  const BUCKET_LABELS = [
    { label: "2 races", min: 2, max: 2 },
    { label: "3 races", min: 3, max: 3 },
    { label: "4–5", min: 4, max: 5 },
    { label: "6–10", min: 6, max: 10 },
    { label: "11+", min: 11, max: Number.POSITIVE_INFINITY },
  ];
  const buckets: RaceRepeatFrequencyBucket[] = BUCKET_LABELS.map((b) => ({
    label: b.label,
    userCount: 0,
    totalPrize: 0,
  }));
  for (const r of allRows) {
    const rc = Number(r.race_count);
    if (!Number.isFinite(rc) || rc < 2) continue;
    const prize = toNumber(r.total_prize);
    const idx = BUCKET_LABELS.findIndex((b) => rc >= b.min && rc <= b.max);
    if (idx === -1) continue;
    buckets[idx].userCount += 1;
    buckets[idx].totalPrize += prize;
  }

  return {
    totalRepeatWinners: allRows.length,
    topRepeatWinners,
    frequencyBuckets: buckets,
  };
}

const cachedShort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeRepeatWinners(period, blacklistIds),
  ["insights-rewards-race-repeat-v1"],
  { revalidate: 60, tags: ["insights-rewards-race"] },
);

const cachedLong = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeRepeatWinners(period, blacklistIds),
  ["insights-rewards-race-repeat-lifetime-v1"],
  { revalidate: 300, tags: ["insights-rewards-race"] },
);

export async function getRaceInsightsRepeatWinners(
  period: InsightsRewardsPeriod,
): Promise<RaceRepeatWinnersResult> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  const ttl = cacheTtlForInsightsPeriod(period);
  return ttl >= 300 ? cachedLong(period, sorted) : cachedShort(period, sorted);
}
