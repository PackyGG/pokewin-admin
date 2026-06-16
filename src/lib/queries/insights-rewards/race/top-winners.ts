import { unstable_cache } from "next/cache";
import { resolveAdminRead } from "@/lib/clickhouse/resolve-read";
import { getRaceInsightsTopWinnersFromClickHouse } from "@/lib/clickhouse/queries/insights-rewards/race/top-winners";
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
 * Top winners by total race prize for the "Top Winners" tab on
 * /insights/rewards/race.
 *
 * Two parallel returns:
 *   - period   — top 25 in the active window (≥ $0.01)
 *   - lifetime — top 25 across all time, regardless of window
 *
 * Each row carries:
 *   - userId / username
 *   - raceCount      — distinct (race_type, race_period_start) hits
 *   - totalPrize     — SUM of `prize_amount_usd` across those races
 *   - avgPrize       — totalPrize / raceCount
 *   - lifetimeTotal  — lifetime sum (shown alongside period total so
 *                       admins can see how concentrated period spend
 *                       is in already-heavy winners)
 *
 * Staff + blacklist excluded. Cached per (period × blacklist).
 */

const TOP_LIMIT = 25;

export type RaceTopWinner = {
  userId: string;
  username: string | null;
  raceCount: number;
  totalPrize: number;
  avgPrize: number;
  lifetimeTotal: number;
};

export type RaceTopWinnersResult = {
  period: RaceTopWinner[];
  lifetime: RaceTopWinner[];
};

async function computeTopWinners(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<RaceTopWinnersResult> {
  const db = await getDb();
  const days = daysForInsightsPeriod(period);
  const dateFilter =
    days !== null
      ? `AND rc.claimed_at >= NOW() - INTERVAL '${days} days'`
      : "";
  const blacklistJoin = blacklistNotInClause("u.id", blacklistIds);

  // Two queries: top by period prize + top by lifetime prize. Both
  // group by user, aggregate prize + race count, return the top N.
  // Lifetime annotation on the period side comes from a final JOIN to
  // the lifetime sub-aggregate so the table can show "lifetime total"
  // alongside the in-window number without a per-row round trip.
  const [periodRows, lifetimeRows] = await Promise.all([
    db.$queryRawUnsafe<
      {
        user_id: string;
        username: string | null;
        race_count: string;
        total_prize: string;
        lifetime_total: string;
      }[]
    >(`
      WITH lifetime AS (
        SELECT rc.user_id, SUM(rc.prize_amount_usd::numeric) AS total
        FROM race_claims rc
        JOIN "user" u ON u.id = rc.user_id
        WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
        GROUP BY rc.user_id
      ),
      period_top AS (
        SELECT
          rc.user_id,
          u.username,
          COUNT(DISTINCT (rc.race_type, rc.race_period_start))::int AS race_count,
          SUM(rc.prize_amount_usd::numeric) AS total_prize
        FROM race_claims rc
        JOIN "user" u ON u.id = rc.user_id
        WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
          ${dateFilter}
        GROUP BY rc.user_id, u.username
        HAVING SUM(rc.prize_amount_usd::numeric) > 0
        ORDER BY SUM(rc.prize_amount_usd::numeric) DESC
        LIMIT ${TOP_LIMIT}
      )
      SELECT
        p.user_id,
        p.username,
        p.race_count::text AS race_count,
        p.total_prize::text AS total_prize,
        COALESCE(l.total, 0)::text AS lifetime_total
      FROM period_top p
      LEFT JOIN lifetime l ON l.user_id = p.user_id
      ORDER BY p.total_prize DESC
    `),
    db.$queryRawUnsafe<
      {
        user_id: string;
        username: string | null;
        race_count: string;
        total_prize: string;
      }[]
    >(`
      SELECT
        rc.user_id,
        u.username,
        COUNT(DISTINCT (rc.race_type, rc.race_period_start))::int AS race_count,
        SUM(rc.prize_amount_usd::numeric) AS total_prize
      FROM race_claims rc
      JOIN "user" u ON u.id = rc.user_id
      WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
      GROUP BY rc.user_id, u.username
      HAVING SUM(rc.prize_amount_usd::numeric) > 0
      ORDER BY SUM(rc.prize_amount_usd::numeric) DESC
      LIMIT ${TOP_LIMIT}
    `),
  ]);

  const periodWinners: RaceTopWinner[] = periodRows.map((r) => {
    const totalPrize = toNumber(r.total_prize);
    const raceCount = Number(r.race_count ?? 0);
    return {
      userId: r.user_id,
      username: r.username,
      raceCount,
      totalPrize,
      avgPrize: raceCount > 0 ? totalPrize / raceCount : 0,
      lifetimeTotal: toNumber(r.lifetime_total),
    };
  });

  const lifetimeWinners: RaceTopWinner[] = lifetimeRows.map((r) => {
    const totalPrize = toNumber(r.total_prize);
    const raceCount = Number(r.race_count ?? 0);
    return {
      userId: r.user_id,
      username: r.username,
      raceCount,
      totalPrize,
      avgPrize: raceCount > 0 ? totalPrize / raceCount : 0,
      lifetimeTotal: totalPrize,
    };
  });

  return { period: periodWinners, lifetime: lifetimeWinners };
}

const cachedShort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    resolveAdminRead<RaceTopWinnersResult>("insights_race_top", {
      pg: () => computeTopWinners(period, blacklistIds),
      ch: () => getRaceInsightsTopWinnersFromClickHouse(period, blacklistIds),
    }),
  ["insights-rewards-race-top-winners-v1"],
  { revalidate: 60, tags: ["insights-rewards-race"] },
);

const cachedLong = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    resolveAdminRead<RaceTopWinnersResult>("insights_race_top", {
      pg: () => computeTopWinners(period, blacklistIds),
      ch: () => getRaceInsightsTopWinnersFromClickHouse(period, blacklistIds),
    }),
  ["insights-rewards-race-top-winners-lifetime-v1"],
  { revalidate: 300, tags: ["insights-rewards-race"] },
);

export async function getRaceInsightsTopWinners(
  period: InsightsRewardsPeriod,
): Promise<RaceTopWinnersResult> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  const ttl = cacheTtlForInsightsPeriod(period);
  return ttl >= 300 ? cachedLong(period, sorted) : cachedShort(period, sorted);
}
