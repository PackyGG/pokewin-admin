import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { RakebackDailyPoint } from "@/lib/queries/insights-rewards/rakeback/daily";

import { getRakebackDailyFromClickHouse } from "../queries/insights-rewards/rakeback/daily";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the rakeback daily series (powers the Overview
 * volume chart + the Daily breakdown tab). No-op unless the
 * `insights_rakeback_daily` surface is in `comparison` mode. Diffs the
 * window-aggregate of the per-day rows — total volume within half a cent; day
 * count, total claim count, and summed per-day distinct claimants exactly.
 * Swallows every error so the served Postgres payload is never affected.
 */
const MONEY_FIELDS = ["totalVolume"] as const;

function flatten(rows: RakebackDailyPoint[]): Record<string, number> {
  return {
    dayCount: rows.length,
    totalCount: rows.reduce((a, r) => a + r.count, 0),
    totalVolume: rows.reduce((a, r) => a + r.volume, 0),
    totalDistinct: rows.reduce((a, r) => a + r.distinctClaimants, 0),
  };
}

export async function compareRakebackDaily(
  period: InsightsRewardsPeriod,
  pgValues: RakebackDailyPoint[],
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_rakeback_daily");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getRakebackDailyFromClickHouse(period, blacklist, now);
    });

    const drift = computeDrift(flatten(pgValues), flatten(ch), MONEY_FIELDS);
    logComparison(`insights_rakeback_daily[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_rakeback_daily",
      "comparison failed (ignored)",
      err,
    );
  }
}
