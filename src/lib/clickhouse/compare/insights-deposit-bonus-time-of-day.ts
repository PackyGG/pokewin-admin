import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";

import { getDepositBonusTimeOfDayFromClickHouse } from "../queries/insights-rewards/deposit-bonus/time-of-day";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the deposit-bonus time-of-day grand totals.
 * No-op unless the `insights_deposit_bonus_time_of_day` surface is in
 * `comparison` mode. Swallows every error — the served Postgres payload is
 * never affected. The PG hour-of-day / day-of-week buckets sum to these totals.
 */
export async function compareDepositBonusTimeOfDay(
  period: InsightsRewardsPeriod,
  pgValues: {
    totalCount: number;
    totalVolume: number;
  },
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_deposit_bonus_time_of_day");
    if (mode !== "comparison") return;

    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getDepositBonusTimeOfDayFromClickHouse(period, blacklist);
    });

    const drift = computeDrift(
      { totalCount: pgValues.totalCount, totalVolume: pgValues.totalVolume },
      { totalCount: ch.totalCount, totalVolume: ch.totalVolume },
      ["totalVolume"],
    );
    logComparison(
      `insights.deposit_bonus.time_of_day[${period}]`,
      drift,
      durationMs,
    );
  } catch (err) {
    logError(
      "clickhouse.compare.insights_deposit_bonus_time_of_day",
      "comparison failed (ignored)",
      err,
    );
  }
}
