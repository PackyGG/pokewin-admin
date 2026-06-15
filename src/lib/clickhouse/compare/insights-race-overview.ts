import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { RaceOverviewKpis } from "@/lib/queries/insights-rewards/race/overview";

import { getRaceInsightsOverviewFromClickHouse } from "../queries/insights-rewards/race/overview";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the race-insights Overview tab
 * (`/insights/rewards/race`). No-op unless the `insights_race_overview` surface
 * is in `comparison` mode (forced off whenever ClickHouse is dormant). Diffs the
 * headline money within half a cent + the counts exactly, plus the daily-series
 * aggregate (day count, summed total, summed prize lines). Swallows every error
 * so the served Postgres payload is never affected.
 */
const MONEY_FIELDS = [
  "totalPrizePaid",
  "avgPrizePerRace",
  "avgPrizePerWinner",
  "dailyTotal",
] as const;

function flatten(o: RaceOverviewKpis): Record<string, number> {
  return {
    totalPrizePaid: o.totalPrizePaid,
    distinctRaces: o.distinctRaces,
    distinctWinners: o.distinctWinners,
    winnerCount: o.winnerCount,
    avgPrizePerRace: o.avgPrizePerRace,
    avgPrizePerWinner: o.avgPrizePerWinner,
    dailyDays: o.dailyPrizes.length,
    dailyTotal: o.dailyPrizes.reduce((a, d) => a + d.total, 0),
    dailyCount: o.dailyPrizes.reduce((a, d) => a + d.count, 0),
  };
}

export async function compareRaceOverview(
  period: InsightsRewardsPeriod,
  pgValues: RaceOverviewKpis,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_race_overview");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getRaceInsightsOverviewFromClickHouse(period, blacklist, now);
    });

    const drift = computeDrift(flatten(pgValues), flatten(ch), MONEY_FIELDS);
    logComparison(`insights_race_overview[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_race_overview",
      "comparison failed (ignored)",
      err,
    );
  }
}
