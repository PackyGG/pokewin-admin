import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { RakebackGeoSource } from "@/lib/queries/insights-rewards/rakeback/geo-source";

import { getRakebackGeoSourceFromClickHouse } from "../queries/insights-rewards/rakeback/geo-source";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the rakeback Geo / Source tab. No-op unless
 * the `insights_rakeback_geo` surface is in `comparison` mode. The grand-total
 * rakeback denominator + the summed top-12 country / top-10 source totals are
 * diffed within half a cent; the bucket counts + summed distinct-user counts
 * exactly. (Top-N bucket membership can shift on a tie; the grand total is the
 * robust exact field.) Swallows every error so the served Postgres payload is
 * never affected.
 */
const MONEY_FIELDS = [
  "totalRakeback",
  "countryTotalSum",
  "sourceTotalSum",
] as const;

function flatten(d: RakebackGeoSource): Record<string, number> {
  return {
    totalRakeback: d.totalRakeback,
    countryCount: d.countries.length,
    sourceCount: d.sources.length,
    countryTotalSum: d.countries.reduce((a, r) => a + r.total, 0),
    sourceTotalSum: d.sources.reduce((a, r) => a + r.total, 0),
    countryUserSum: d.countries.reduce((a, r) => a + r.userCount, 0),
    sourceUserSum: d.sources.reduce((a, r) => a + r.userCount, 0),
  };
}

export async function compareRakebackGeo(
  period: InsightsRewardsPeriod,
  pgValues: RakebackGeoSource,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_rakeback_geo");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getRakebackGeoSourceFromClickHouse(period, blacklist, now);
    });

    const drift = computeDrift(flatten(pgValues), flatten(ch), MONEY_FIELDS);
    logComparison(`insights_rakeback_geo[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_rakeback_geo",
      "comparison failed (ignored)",
      err,
    );
  }
}
