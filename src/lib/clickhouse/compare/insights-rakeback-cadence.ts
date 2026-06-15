import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { RakebackCadence } from "@/lib/queries/insights-rewards/rakeback/cadence";

import { getRakebackCadenceFromClickHouse } from "../queries/insights-rewards/rakeback/cadence";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the rakeback Cadence tab. No-op unless the
 * `insights_rakeback_cadence` surface is in `comparison` mode. Total claims,
 * distinct claimants, and the per-gap histogram buckets must match exactly; the
 * avg-claims-per-user and median-gap (derived floats) are diffed within the
 * half-cent tolerance. Swallows every error so the served Postgres payload is
 * never affected.
 */
const TOLERANCE_FIELDS = ["avgClaimsPerActiveUser", "medianGapHours"] as const;

function flatten(c: RakebackCadence): Record<string, number> {
  const rec: Record<string, number> = {
    totalClaims: c.totalClaims,
    distinctClaimants: c.distinctClaimants,
    avgClaimsPerActiveUser: c.avgClaimsPerActiveUser,
    medianGapHours: c.medianGapHours,
  };
  for (const b of c.buckets) rec[`bucket:${b.label}`] = b.count;
  return rec;
}

export async function compareRakebackCadence(
  period: InsightsRewardsPeriod,
  pgValues: RakebackCadence,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_rakeback_cadence");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getRakebackCadenceFromClickHouse(period, blacklist, now);
    });

    const drift = computeDrift(flatten(pgValues), flatten(ch), TOLERANCE_FIELDS);
    logComparison(`insights_rakeback_cadence[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_rakeback_cadence",
      "comparison failed (ignored)",
      err,
    );
  }
}
