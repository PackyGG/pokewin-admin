import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { RacePositionBucket } from "@/lib/queries/insights-rewards/race/positions";

import { getRaceInsightsPositionsFromClickHouse } from "../queries/insights-rewards/race/positions";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the race-insights Positions tab. No-op unless
 * the `insights_race_positions` surface is in `comparison` mode. The five
 * position buckets are deterministic (no top-N / tie ambiguity), so each
 * bucket's count is diffed exactly and its USD volume within half a cent.
 * Swallows every error so the served Postgres payload is never affected.
 */
const MONEY_FIELDS = [
  "b0Vol",
  "b1Vol",
  "b2Vol",
  "b3Vol",
  "b4Vol",
  "totalVol",
] as const;

function flatten(buckets: RacePositionBucket[]): Record<string, number> {
  const rec: Record<string, number> = {};
  let totalCount = 0;
  let totalVol = 0;
  buckets.forEach((b, i) => {
    rec[`b${i}Count`] = b.count;
    rec[`b${i}Vol`] = b.volume;
    totalCount += b.count;
    totalVol += b.volume;
  });
  rec.totalCount = totalCount;
  rec.totalVol = totalVol;
  return rec;
}

export async function compareRacePositions(
  period: InsightsRewardsPeriod,
  pgValues: RacePositionBucket[],
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_race_positions");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getRaceInsightsPositionsFromClickHouse(period, blacklist, now);
    });

    const drift = computeDrift(flatten(pgValues), flatten(ch), MONEY_FIELDS);
    logComparison(`insights_race_positions[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_race_positions",
      "comparison failed (ignored)",
      err,
    );
  }
}
