import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { RaceRepeatWinnersResult } from "@/lib/queries/insights-rewards/race/repeat-winners";

import { getRaceInsightsRepeatWinnersFromClickHouse } from "../queries/insights-rewards/race/repeat-winners";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the race-insights Repeat-winners tab. No-op
 * unless the `insights_race_repeat` surface is in `comparison` mode. Diffs the
 * repeat-winner head count + the five (stable, full-population) frequency
 * buckets — each bucket's user count exactly and its prize within half a cent.
 * The top-10 list (no tiebreaker on either engine) is excluded from drift.
 * Swallows every error so the served Postgres payload is never affected.
 */
const MONEY_FIELDS = [
  "bucket0Prize",
  "bucket1Prize",
  "bucket2Prize",
  "bucket3Prize",
  "bucket4Prize",
] as const;

function flatten(o: RaceRepeatWinnersResult): Record<string, number> {
  const rec: Record<string, number> = {
    totalRepeatWinners: o.totalRepeatWinners,
    topRowCount: o.topRepeatWinners.length,
  };
  o.frequencyBuckets.forEach((b, i) => {
    rec[`bucket${i}Count`] = b.userCount;
    rec[`bucket${i}Prize`] = b.totalPrize;
  });
  return rec;
}

export async function compareRaceRepeat(
  period: InsightsRewardsPeriod,
  pgValues: RaceRepeatWinnersResult,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_race_repeat");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getRaceInsightsRepeatWinnersFromClickHouse(period, blacklist, now);
    });

    const drift = computeDrift(flatten(pgValues), flatten(ch), MONEY_FIELDS);
    logComparison(`insights_race_repeat[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_race_repeat",
      "comparison failed (ignored)",
      err,
    );
  }
}
