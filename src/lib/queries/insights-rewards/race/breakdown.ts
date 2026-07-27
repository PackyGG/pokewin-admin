import { blacklistNotInSql, daysAgoFilter, queryRows, sql } from "@/lib/queries/insights-rewards/_drizzle-query";
import { unstable_cache } from "next/cache";
import { getReadDrizzleDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { toNumber } from "@/lib/utils/decimal";
import {
  daysForInsightsPeriod,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "../_period";

/**
 * Race-by-race breakdown for the Breakdown tab on /insights/rewards/race.
 *
 * One row per (race_type, race_period_start) — every race instance that
 * had at least one winner in the window. Each row carries:
 *
 *   - raceType        — daily / weekly / monthly enum
 *   - periodStart     — race instance identifier (ISO date)
 *   - prizePool       — SUM of `race_claims.prize_amount_usd` for the race
 *   - winnerCount     — number of distinct positions claimed
 *   - topPosition     — best (lowest) position observed
 *   - topPrize        — prize amount at the best observed position
 *   - topUserId       — user that held that best position
 *   - topUsername     — display name for the user
 *   - positionSpread  — best..worst position span (worstPos - bestPos + 1)
 *   - configuredBudget — SUM of `race_prize_tiers` for the same race type
 *                       (NULL when no tiers configured for that type)
 *   - tierUtilisation — prizePool / configuredBudget (NULL when no budget)
 *
 * Staff + blacklist excluded. Cached per (period × blacklist). Returned
 * sorted by prize pool descending — the heaviest races surface first.
 */

export type RaceBreakdownRow = {
  raceType: "daily" | "weekly" | "monthly" | string;
  periodStart: string;
  prizePool: number;
  winnerCount: number;
  topPosition: number;
  topPrize: number;
  topUserId: string;
  topUsername: string | null;
  positionSpread: number;
  configuredBudget: number | null;
  tierUtilisation: number | null;
};

async function computeBreakdown(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<RaceBreakdownRow[]> {
  const db = await getReadDrizzleDb();
  const days = daysForInsightsPeriod(period);
  const dateFilter = daysAgoFilter("rc.claimed_at", days);
  const blacklistJoin = blacklistNotInSql("u.id", blacklistIds);

  // Per-race aggregate + the top (lowest-position) winner attached via a
  // window-function pick. We aggregate prize_pool/winner_count/min position
  // in the inner CTE, then JOIN back to the row that hit MIN(position) so
  // the top winner's user_id + username + actual prize amount come along
  // without a second round trip.
  const races = await queryRows<
    {
      race_type: string;
      period_start: Date | string;
      prize_pool: string;
      winner_count: string;
      top_position: number;
      max_position: number;
      top_prize: string;
      top_user_id: string;
      top_username: string | null;
    }[]
  >(db, sql`
    WITH per_race AS (
      SELECT
        rc.race_type::text AS race_type,
        rc.race_period_start AS period_start,
        SUM(rc.prize_amount_usd::numeric) AS prize_pool,
        COUNT(*) AS winner_count,
        MIN(rc.position) AS top_position,
        MAX(rc.position) AS max_position
      FROM race_claims rc
      JOIN "user" u ON u.id = rc.user_id
      WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${dateFilter}
      GROUP BY rc.race_type, rc.race_period_start
    ),
    top_winners AS (
      SELECT DISTINCT ON (rc.race_type, rc.race_period_start)
        rc.race_type::text AS race_type,
        rc.race_period_start AS period_start,
        rc.user_id AS top_user_id,
        u.username AS top_username,
        rc.prize_amount_usd::numeric AS top_prize,
        rc.position AS pos
      FROM race_claims rc
      JOIN "user" u ON u.id = rc.user_id
      WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${dateFilter}
      ORDER BY rc.race_type, rc.race_period_start, rc.position ASC
    )
    SELECT
      p.race_type,
      p.period_start,
      p.prize_pool::text AS prize_pool,
      p.winner_count::text AS winner_count,
      p.top_position::int AS top_position,
      p.max_position::int AS max_position,
      t.top_prize::text AS top_prize,
      t.top_user_id,
      t.top_username
    FROM per_race p
    LEFT JOIN top_winners t
      ON t.race_type = p.race_type
     AND t.period_start = p.period_start
    ORDER BY p.prize_pool DESC
  `);

  // Per-race-type configured budget — SUM of prize_amount_usd from
  // race_prize_tiers per race_type. Cheap one-row aggregate per type
  // (table has ≤ ~60 rows total). Build a lookup map and zip onto the
  // breakdown rows so each race instance knows its tier ceiling.
  const tierBudgets = await queryRows<
    { race_type: string; total: string }[]
  >(db, sql`
    SELECT race_type::text AS race_type, COALESCE(SUM(prize_amount_usd::numeric), 0)::text AS total
    FROM race_prize_tiers
    GROUP BY race_type
  `);
  const budgetByType = new Map<string, number>();
  for (const r of tierBudgets) {
    budgetByType.set(r.race_type, toNumber(r.total));
  }

  return races.map((r) => {
    const prizePool = toNumber(r.prize_pool);
    const configuredBudget = budgetByType.get(r.race_type) ?? null;
    const tierUtilisation =
      configuredBudget !== null && configuredBudget > 0
        ? prizePool / configuredBudget
        : null;
    const topPosition = Number(r.top_position);
    const maxPosition = Number(r.max_position);
    const positionSpread =
      Number.isFinite(topPosition) && Number.isFinite(maxPosition)
        ? maxPosition - topPosition + 1
        : 0;
    return {
      raceType: r.race_type,
      periodStart: new Date(r.period_start).toISOString().split("T")[0],
      prizePool,
      winnerCount: Number(r.winner_count),
      topPosition,
      topPrize: toNumber(r.top_prize),
      topUserId: r.top_user_id,
      topUsername: r.top_username,
      positionSpread,
      configuredBudget,
      tierUtilisation,
    };
  });
}

const cachedShort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeBreakdown(period, blacklistIds),
  ["insights-rewards-race-breakdown-v1"],
  { revalidate: 60, tags: ["insights-rewards-race"] },
);

const cachedLong = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeBreakdown(period, blacklistIds),
  ["insights-rewards-race-breakdown-lifetime-v1"],
  { revalidate: 300, tags: ["insights-rewards-race"] },
);

export async function getRaceInsightsBreakdown(
  period: InsightsRewardsPeriod,
): Promise<RaceBreakdownRow[]> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  const ttl = cacheTtlForInsightsPeriod(period);
  return ttl >= 300 ? cachedLong(period, sorted) : cachedShort(period, sorted);
}
