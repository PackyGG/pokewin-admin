import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { RacePerTypeRow } from "@/lib/queries/insights-rewards/race/per-type";

import { getRaceInsightsPerTypeFromClickHouse } from "../queries/insights-rewards/race/per-type";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the race-insights Per-type tab (also backs the
 * Budget tab — same query). No-op unless the `insights_race_per_type` surface is
 * in `comparison` mode. Diffs the per-type aggregate summed across types: prize
 * pool / configured budget / window ceiling within half a cent, distinct races /
 * prize lines / distinct winners exactly, plus the entrant-derived avg entrants
 * per race within tolerance. Swallows every error so the served Postgres payload
 * is never affected.
 */
const MONEY_FIELDS = [
  "prizePoolTotalSum",
  "configuredBudgetSum",
  "tierBudgetForWindowSum",
  "avgEntrantsPerRaceSum",
] as const;

function flatten(rows: RacePerTypeRow[]): Record<string, number> {
  return {
    distinctRacesSum: rows.reduce((a, r) => a + r.distinctRaces, 0),
    prizePoolTotalSum: rows.reduce((a, r) => a + r.prizePoolTotal, 0),
    winnerCountSum: rows.reduce((a, r) => a + r.winnerCount, 0),
    distinctWinnersSum: rows.reduce((a, r) => a + r.distinctWinners, 0),
    configuredBudgetSum: rows.reduce((a, r) => a + r.configuredBudget, 0),
    tierBudgetForWindowSum: rows.reduce((a, r) => a + r.tierBudgetForWindow, 0),
    avgEntrantsPerRaceSum: rows.reduce((a, r) => a + r.avgEntrantsPerRace, 0),
  };
}

export async function compareRacePerType(
  period: InsightsRewardsPeriod,
  pgValues: RacePerTypeRow[],
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_race_per_type");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getRaceInsightsPerTypeFromClickHouse(period, blacklist, now);
    });

    const drift = computeDrift(flatten(pgValues), flatten(ch), MONEY_FIELDS);
    logComparison(`insights_race_per_type[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_race_per_type",
      "comparison failed (ignored)",
      err,
    );
  }
}
