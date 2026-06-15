import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";

import { getDepositBonusGeoSourceFromClickHouse } from "../queries/insights-rewards/deposit-bonus/geo-source";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the deposit-bonus geo/source reference total.
 * No-op unless the `insights_deposit_bonus_geo_source` surface is in
 * `comparison` mode. Swallows every error — the served Postgres payload is
 * never affected.
 */
export async function compareDepositBonusGeoSource(
  period: InsightsRewardsPeriod,
  pgValues: {
    totalCost: number;
  },
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_deposit_bonus_geo_source");
    if (mode !== "comparison") return;

    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getDepositBonusGeoSourceFromClickHouse(period, blacklist);
    });

    const drift = computeDrift(
      { totalCost: pgValues.totalCost },
      { totalCost: ch.totalCost },
      ["totalCost"],
    );
    logComparison(
      `insights.deposit_bonus.geo_source[${period}]`,
      drift,
      durationMs,
    );
  } catch (err) {
    logError(
      "clickhouse.compare.insights_deposit_bonus_geo_source",
      "comparison failed (ignored)",
      err,
    );
  }
}
