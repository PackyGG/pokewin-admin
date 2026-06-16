import { unstable_cache } from "next/cache";
import { resolveAdminRead } from "@/lib/clickhouse/resolve-read";
import { getRaceInsightsOverviewFromClickHouse } from "@/lib/clickhouse/queries/insights-rewards/race/overview";
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
 * Overview headline KPIs + daily prize chart for /insights/rewards/race.
 *
 * Source of truth is `race_claims` — one row per (user, race instance,
 * position) carrying `prize_amount_usd`. Staff + blacklist excluded via
 * the same join pattern the rest of the rewards-insights module uses.
 *
 * What the helper returns:
 *   - totalPrizePaid       — sum of `prize_amount_usd` in window
 *   - distinctRaces        — count of distinct (race_type, race_period_start)
 *   - distinctWinners      — count of distinct claimant user_ids
 *   - winnerCount          — count of race_claims rows (= prize lines)
 *   - avgPrizePerRace      — totalPrizePaid / distinctRaces (0 when no races)
 *   - avgPrizePerWinner    — totalPrizePaid / distinctWinners
 *   - dailyPrizes          — date-bucketed series for the chart
 *
 * House-POV: race prizes are payouts → rose. Caller decides accent.
 *
 * Cached per (period × blacklist). Lifetime gets the 5-minute TTL since
 * it barely moves; shorter windows get the 60s TTL.
 */

export type RacePrizeDailyPoint = {
  date: string;
  total: number;
  count: number;
};

export type RaceOverviewKpis = {
  totalPrizePaid: number;
  distinctRaces: number;
  distinctWinners: number;
  winnerCount: number;
  avgPrizePerRace: number;
  avgPrizePerWinner: number;
  dailyPrizes: RacePrizeDailyPoint[];
};

async function computeOverview(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<RaceOverviewKpis> {
  const db = await getDb();
  const days = daysForInsightsPeriod(period);
  const dateFilter =
    days !== null
      ? `AND rc.claimed_at >= NOW() - INTERVAL '${days} days'`
      : "";
  const blacklistJoin = blacklistNotInClause("u.id", blacklistIds);

  // One rollup query + one daily-series query in parallel. Both join to
  // user for staff + blacklist exclusion, both sweep race_claims.
  const [rollupRows, dailyRows] = await Promise.all([
    db.$queryRawUnsafe<
      {
        total: string;
        distinct_races: string;
        distinct_winners: string;
        winner_count: string;
      }[]
    >(`
      SELECT
        COALESCE(SUM(rc.prize_amount_usd::numeric), 0)::text AS total,
        COUNT(DISTINCT (rc.race_type, rc.race_period_start))::text AS distinct_races,
        COUNT(DISTINCT rc.user_id)::text AS distinct_winners,
        COUNT(*)::text AS winner_count
      FROM race_claims rc
      JOIN "user" u ON u.id = rc.user_id
      WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${dateFilter}
    `),
    db.$queryRawUnsafe<
      { date: Date; total: string; cnt: string }[]
    >(`
      SELECT
        DATE(rc.claimed_at) AS date,
        COALESCE(SUM(rc.prize_amount_usd::numeric), 0)::text AS total,
        COUNT(*)::text AS cnt
      FROM race_claims rc
      JOIN "user" u ON u.id = rc.user_id
      WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${dateFilter}
      GROUP BY DATE(rc.claimed_at)
      ORDER BY date ASC
    `),
  ]);

  const r = rollupRows[0];
  const totalPrizePaid = toNumber(r?.total);
  const distinctRaces = Number(r?.distinct_races ?? 0);
  const distinctWinners = Number(r?.distinct_winners ?? 0);
  const winnerCount = Number(r?.winner_count ?? 0);
  const avgPrizePerRace =
    distinctRaces > 0 ? totalPrizePaid / distinctRaces : 0;
  const avgPrizePerWinner =
    distinctWinners > 0 ? totalPrizePaid / distinctWinners : 0;

  const dailyPrizes: RacePrizeDailyPoint[] = dailyRows.map((row) => ({
    date: new Date(row.date).toISOString().split("T")[0],
    total: toNumber(row.total),
    count: Number(row.cnt),
  }));

  return {
    totalPrizePaid,
    distinctRaces,
    distinctWinners,
    winnerCount,
    avgPrizePerRace,
    avgPrizePerWinner,
    dailyPrizes,
  };
}

const cachedShort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    resolveAdminRead<RaceOverviewKpis>("insights_race_overview", {
      pg: () => computeOverview(period, blacklistIds),
      ch: () => getRaceInsightsOverviewFromClickHouse(period, blacklistIds),
    }),
  ["insights-rewards-race-overview-v1"],
  { revalidate: 60, tags: ["insights-rewards-race"] },
);

const cachedLong = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    resolveAdminRead<RaceOverviewKpis>("insights_race_overview", {
      pg: () => computeOverview(period, blacklistIds),
      ch: () => getRaceInsightsOverviewFromClickHouse(period, blacklistIds),
    }),
  ["insights-rewards-race-overview-lifetime-v1"],
  { revalidate: 300, tags: ["insights-rewards-race"] },
);

export async function getRaceInsightsOverview(
  period: InsightsRewardsPeriod,
): Promise<RaceOverviewKpis> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  const ttl = cacheTtlForInsightsPeriod(period);
  return ttl >= 300 ? cachedLong(period, sorted) : cachedShort(period, sorted);
}
