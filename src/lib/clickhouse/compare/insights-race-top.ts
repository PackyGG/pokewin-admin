import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { RaceTopWinnersResult } from "@/lib/queries/insights-rewards/race/top-winners";

import { getRaceInsightsTopWinnersFromClickHouse } from "../queries/insights-rewards/race/top-winners";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the race-insights Top-winners tab. No-op unless
 * the `insights_race_top` surface is in `comparison` mode. Diffs the leaderboard
 * aggregate for both the period and lifetime top-25 — Σ prize + Σ lifetime
 * within half a cent, row count + Σ race_count exactly. (`ORDER BY prize DESC
 * LIMIT 25` has no tiebreaker on either engine; the aggregate is stable whenever
 * the top-25 sums are distinct.) Swallows every error so the served Postgres
 * payload is never affected.
 */
const MONEY_FIELDS = [
  "periodPrizeSum",
  "periodLifetimeSum",
  "lifetimePrizeSum",
] as const;

function flatten(o: RaceTopWinnersResult): Record<string, number> {
  return {
    periodRowCount: o.period.length,
    periodPrizeSum: o.period.reduce((a, r) => a + r.totalPrize, 0),
    periodRaceCountSum: o.period.reduce((a, r) => a + r.raceCount, 0),
    periodLifetimeSum: o.period.reduce((a, r) => a + r.lifetimeTotal, 0),
    lifetimeRowCount: o.lifetime.length,
    lifetimePrizeSum: o.lifetime.reduce((a, r) => a + r.totalPrize, 0),
    lifetimeRaceCountSum: o.lifetime.reduce((a, r) => a + r.raceCount, 0),
  };
}

export async function compareRaceTop(
  period: InsightsRewardsPeriod,
  pgValues: RaceTopWinnersResult,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_race_top");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getRaceInsightsTopWinnersFromClickHouse(period, blacklist, now);
    });

    const drift = computeDrift(flatten(pgValues), flatten(ch), MONEY_FIELDS);
    logComparison(`insights_race_top[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_race_top",
      "comparison failed (ignored)",
      err,
    );
  }
}
