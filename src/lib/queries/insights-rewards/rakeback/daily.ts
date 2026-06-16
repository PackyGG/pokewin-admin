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
import { getRakebackDailyFromClickHouse } from "@/lib/clickhouse/queries/insights-rewards/rakeback/daily";

/**
 * Day-by-day breakdown for the rakeback insights page:
 *   - claim count
 *   - rakeback volume
 *   - average per claim
 *   - distinct claimants
 *
 * Powers the daily-volume area chart on the Overview tab AND the
 * "Daily breakdown" table tab. Single query — both surfaces consume the
 * same shape.
 *
 * Source: `rakeback_claims` with `claimed_at` non-null. Staff + blacklist
 * excluded. Returned sorted ASC by date.
 */

export type RakebackDailyPoint = {
  /** YYYY-MM-DD (UTC truncated). */
  date: string;
  count: number;
  volume: number;
  avg: number;
  distinctClaimants: number;
};

async function computeDaily(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<RakebackDailyPoint[]> {
  const db = await getDb();
  const days = daysForInsightsPeriod(period);
  const blacklistJoin = blacklistNotInClause("u.id", blacklistIds);
  const dateFilter =
    days !== null ? `AND rc.claimed_at >= NOW() - INTERVAL '${days} days'` : "";

  const rows = await db.$queryRawUnsafe<
    {
      date: Date;
      cnt: string;
      volume: string;
      distinct_users: string;
    }[]
  >(`
    SELECT
      DATE(rc.claimed_at) AS date,
      COUNT(*)::text AS cnt,
      COALESCE(SUM(rc.rakeback_amount_usd::numeric), 0)::text AS volume,
      COUNT(DISTINCT rc.user_id)::text AS distinct_users
    FROM rakeback_claims rc
    JOIN "user" u ON u.id = rc.user_id
    WHERE rc.claimed_at IS NOT NULL
      AND u.role NOT IN ('admin', 'support', 'creator') ${blacklistJoin}
      ${dateFilter}
    GROUP BY DATE(rc.claimed_at)
    ORDER BY date ASC
  `);

  return rows.map((r) => {
    const count = Number(r.cnt);
    const volume = toNumber(r.volume);
    return {
      date: new Date(r.date).toISOString().split("T")[0],
      count,
      volume,
      avg: count > 0 ? volume / count : 0,
      distinctClaimants: Number(r.distinct_users),
    };
  });
}

// CQRS serve-path: clickhouse mode serves the CH twin (SOLE read, throws
// through the cache on failure); off/comparison serve Postgres unchanged.
async function resolveDaily(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<RakebackDailyPoint[]> {
  return resolveAdminRead<RakebackDailyPoint[]>("insights_rakeback_daily", {
    pg: () => computeDaily(period, blacklistIds),
    ch: () => getRakebackDailyFromClickHouse(period, blacklistIds),
  });
}

const cachedShort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    resolveDaily(period, blacklistIds),
  ["insights-rewards-rakeback-daily-v1"],
  { revalidate: 60, tags: ["rewards-analytics", "insights-rewards-rakeback"] },
);

const cachedLong = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    resolveDaily(period, blacklistIds),
  ["insights-rewards-rakeback-daily-lifetime-v1"],
  { revalidate: 300, tags: ["rewards-analytics", "insights-rewards-rakeback"] },
);

export async function getRakebackDaily(
  period: InsightsRewardsPeriod,
): Promise<RakebackDailyPoint[]> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  return cacheTtlForInsightsPeriod(period) >= 300
    ? cachedLong(period, sorted)
    : cachedShort(period, sorted);
}
