import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { RaceCohortResult } from "@/lib/queries/insights-rewards/race/cohort";

import { getRaceInsightsCohortFromClickHouse } from "../queries/insights-rewards/race/cohort";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the race-insights Cohort & Geo tab. No-op
 * unless the `insights_race_cohort` surface is in `comparison` mode. Diffs the
 * winner head count + the six (stable) signup-recency buckets — each bucket's
 * winner count exactly + its prize within half a cent — plus the country/source
 * list lengths. The country/source rows are top-N by an aggregate with no
 * tiebreaker (mirrors PG), so their summed money is NOT diffed here (the parity
 * script proves the order-independent full-population aggregates). Swallows
 * every error so the served Postgres payload is never affected.
 */
const MONEY_FIELDS = [
  "signup0Prize",
  "signup1Prize",
  "signup2Prize",
  "signup3Prize",
  "signup4Prize",
  "signup5Prize",
] as const;

function flatten(o: RaceCohortResult): Record<string, number> {
  const rec: Record<string, number> = {
    // Each winner falls in exactly one signup bucket → Σ winnerCount = total.
    totalWinners: o.signupCohorts.reduce((a, r) => a + r.winnerCount, 0),
    countriesRowCount: o.countries.length,
    sourcesRowCount: o.sources.length,
    cohortRowCount: o.signupCohorts.length,
  };
  o.signupCohorts.forEach((b, i) => {
    rec[`signup${i}Count`] = b.winnerCount;
    rec[`signup${i}Prize`] = b.totalPrize;
  });
  return rec;
}

export async function compareRaceCohort(
  period: InsightsRewardsPeriod,
  pgValues: RaceCohortResult,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_race_cohort");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getRaceInsightsCohortFromClickHouse(period, blacklist, now);
    });

    const drift = computeDrift(flatten(pgValues), flatten(ch), MONEY_FIELDS);
    logComparison(`insights_race_cohort[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_race_cohort",
      "comparison failed (ignored)",
      err,
    );
  }
}
