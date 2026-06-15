import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { RakebackRateDistribution } from "@/lib/queries/insights-rewards/rakeback/rate-distribution";

import { getRakebackRateDistributionFromClickHouse } from "../queries/insights-rewards/rakeback/rate-distribution";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the rakeback "% of wager" tab. No-op unless
 * the `insights_rakeback_rate` surface is in `comparison` mode. The cohort size
 * + per-bucket claimant counts must match exactly; the volume-weighted avg,
 * median, and p95 percentages are diffed within the half-cent tolerance (they
 * are derived floats). Swallows every error so the served Postgres payload is
 * never affected.
 */
const TOLERANCE_FIELDS = [
  "avgPctOfWager",
  "medianPctOfWager",
  "p95PctOfWager",
] as const;

function flatten(d: RakebackRateDistribution): Record<string, number> {
  const rec: Record<string, number> = {
    avgPctOfWager: d.avgPctOfWager,
    medianPctOfWager: d.medianPctOfWager,
    p95PctOfWager: d.p95PctOfWager,
    cohortSize: d.cohortSize,
  };
  for (const b of d.buckets) rec[`bucket:${b.label}`] = b.count;
  return rec;
}

export async function compareRakebackRate(
  period: InsightsRewardsPeriod,
  pgValues: RakebackRateDistribution,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_rakeback_rate");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getRakebackRateDistributionFromClickHouse(period, blacklist, now);
    });

    const drift = computeDrift(flatten(pgValues), flatten(ch), TOLERANCE_FIELDS);
    logComparison(`insights_rakeback_rate[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_rakeback_rate",
      "comparison failed (ignored)",
      err,
    );
  }
}
