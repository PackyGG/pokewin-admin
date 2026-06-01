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
 * Per-race-type stats for the "Per Type" tab on /insights/rewards/race.
 *
 * One row per race_type (daily / weekly / monthly) carrying:
 *
 *   - raceType            — daily / weekly / monthly enum
 *   - distinctRaces       — count of distinct (race_type, race_period_start)
 *                           with at least one winner in window
 *   - prizePoolTotal      — SUM of `race_claims.prize_amount_usd`
 *   - winnerCount         — total prize lines (sum across all races)
 *   - distinctWinners     — distinct claimant user_ids for this race type
 *   - avgPrizePerRace     — prizePoolTotal / distinctRaces
 *   - configuredBudget    — SUM of `race_prize_tiers.prize_amount_usd`
 *                           for that race_type (per-race ceiling)
 *   - tierBudgetForWindow — configuredBudget * distinctRaces, sum spend
 *                           ceiling for the run races in the window
 *   - tierUtilisation     — prizePoolTotal / tierBudgetForWindow (NULL when
 *                           ceiling unset)
 *   - avgEntrantsPerRace  — average `race_leaderboard_snapshots` entries
 *                           per race instance in window (entrant cohort
 *                           size). Approximates "people who tried"
 *   - conversionRate      — distinct winners / distinct entrants
 *                           (= placers / participants). Entry-to-prize
 *                           conversion at the race level.
 *
 * Staff + blacklist excluded. Cached per (period × blacklist).
 */

const RACE_TYPES: Array<"daily" | "weekly" | "monthly"> = [
  "daily",
  "weekly",
  "monthly",
];

export type RacePerTypeRow = {
  raceType: "daily" | "weekly" | "monthly";
  distinctRaces: number;
  prizePoolTotal: number;
  winnerCount: number;
  distinctWinners: number;
  avgPrizePerRace: number;
  configuredBudget: number;
  tierBudgetForWindow: number;
  tierUtilisation: number | null;
  avgEntrantsPerRace: number;
  conversionRate: number | null;
};

async function computePerType(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<RacePerTypeRow[]> {
  const db = await getDb();
  const days = daysForInsightsPeriod(period);
  const dateClaims =
    days !== null
      ? `AND rc.claimed_at >= NOW() - INTERVAL '${days} days'`
      : "";
  const dateSnapshots =
    days !== null
      ? `AND rls.period_start >= (NOW() - INTERVAL '${days} days')::date`
      : "";
  const blacklistJoin = blacklistNotInClause("u.id", blacklistIds);

  // Three parallel queries: per-type claim rollup + per-type entrant
  // (snapshot) rollup + per-type configured budget. All zip together in
  // post-processing.
  const [claimRows, entrantRows, budgetRows] = await Promise.all([
    db.$queryRawUnsafe<
      {
        race_type: string;
        distinct_races: string;
        prize_pool: string;
        winner_count: string;
        distinct_winners: string;
      }[]
    >(`
      SELECT
        rc.race_type::text AS race_type,
        COUNT(DISTINCT (rc.race_period_start))::text AS distinct_races,
        COALESCE(SUM(rc.prize_amount_usd::numeric), 0)::text AS prize_pool,
        COUNT(*)::text AS winner_count,
        COUNT(DISTINCT rc.user_id)::text AS distinct_winners
      FROM race_claims rc
      JOIN "user" u ON u.id = rc.user_id
      WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${dateClaims}
      GROUP BY rc.race_type
    `),
    // Entrant counts come from race_leaderboard_snapshots. We count each
    // (user, race_type, period_start) as one entrant. The avg entrants
    // per race = total entries / distinct races. Same staff + blacklist
    // exclusion via JOIN to user.
    db.$queryRawUnsafe<
      {
        race_type: string;
        distinct_races: string;
        total_entries: string;
        distinct_entrants: string;
      }[]
    >(`
      SELECT
        rls.race_type::text AS race_type,
        COUNT(DISTINCT (rls.period_start))::text AS distinct_races,
        COUNT(*)::text AS total_entries,
        COUNT(DISTINCT rls.user_id)::text AS distinct_entrants
      FROM race_leaderboard_snapshots rls
      JOIN "user" u ON u.id = rls.user_id
      WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${dateSnapshots}
      GROUP BY rls.race_type
    `),
    db.$queryRawUnsafe<{ race_type: string; total: string }[]>(`
      SELECT race_type::text AS race_type, COALESCE(SUM(prize_amount_usd::numeric), 0)::text AS total
      FROM race_prize_tiers
      GROUP BY race_type
    `),
  ]);

  const claimByType = new Map<
    string,
    {
      distinctRaces: number;
      prizePool: number;
      winnerCount: number;
      distinctWinners: number;
    }
  >();
  for (const r of claimRows) {
    claimByType.set(r.race_type, {
      distinctRaces: Number(r.distinct_races ?? 0),
      prizePool: toNumber(r.prize_pool),
      winnerCount: Number(r.winner_count ?? 0),
      distinctWinners: Number(r.distinct_winners ?? 0),
    });
  }
  const entrantByType = new Map<
    string,
    { distinctRaces: number; totalEntries: number; distinctEntrants: number }
  >();
  for (const r of entrantRows) {
    entrantByType.set(r.race_type, {
      distinctRaces: Number(r.distinct_races ?? 0),
      totalEntries: Number(r.total_entries ?? 0),
      distinctEntrants: Number(r.distinct_entrants ?? 0),
    });
  }
  const budgetByType = new Map<string, number>();
  for (const r of budgetRows) {
    budgetByType.set(r.race_type, toNumber(r.total));
  }

  return RACE_TYPES.map((t) => {
    const claims = claimByType.get(t) ?? {
      distinctRaces: 0,
      prizePool: 0,
      winnerCount: 0,
      distinctWinners: 0,
    };
    const entrants = entrantByType.get(t) ?? {
      distinctRaces: 0,
      totalEntries: 0,
      distinctEntrants: 0,
    };
    const configuredBudget = budgetByType.get(t) ?? 0;
    const tierBudgetForWindow = configuredBudget * claims.distinctRaces;
    const tierUtilisation =
      tierBudgetForWindow > 0 ? claims.prizePool / tierBudgetForWindow : null;
    const avgPrizePerRace =
      claims.distinctRaces > 0 ? claims.prizePool / claims.distinctRaces : 0;
    // Avg entrants per race uses the entrants table's own distinct race
    // count (typically equal to claims.distinctRaces; on edge cases
    // where a race ended before payout the snapshot count can still be
    // larger).
    const avgEntrantsPerRace =
      entrants.distinctRaces > 0
        ? entrants.totalEntries / entrants.distinctRaces
        : 0;
    const conversionRate =
      entrants.distinctEntrants > 0
        ? claims.distinctWinners / entrants.distinctEntrants
        : null;
    return {
      raceType: t,
      distinctRaces: claims.distinctRaces,
      prizePoolTotal: claims.prizePool,
      winnerCount: claims.winnerCount,
      distinctWinners: claims.distinctWinners,
      avgPrizePerRace,
      configuredBudget,
      tierBudgetForWindow,
      tierUtilisation,
      avgEntrantsPerRace,
      conversionRate,
    };
  });
}

const cachedShort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computePerType(period, blacklistIds),
  ["insights-rewards-race-per-type-v1"],
  { revalidate: 60, tags: ["insights-rewards-race"] },
);

const cachedLong = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computePerType(period, blacklistIds),
  ["insights-rewards-race-per-type-lifetime-v1"],
  { revalidate: 300, tags: ["insights-rewards-race"] },
);

export async function getRaceInsightsPerType(
  period: InsightsRewardsPeriod,
): Promise<RacePerTypeRow[]> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  const ttl = cacheTtlForInsightsPeriod(period);
  return ttl >= 300 ? cachedLong(period, sorted) : cachedShort(period, sorted);
}
