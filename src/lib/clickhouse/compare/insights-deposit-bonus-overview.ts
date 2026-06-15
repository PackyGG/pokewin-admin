import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";

import { getDepositBonusOverviewFromClickHouse } from "../queries/insights-rewards/deposit-bonus/overview";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the deposit-bonus Overview headline. No-op
 * unless the `insights_deposit_bonus_overview` surface is in `comparison` mode
 * (forced off whenever ClickHouse is dormant). Swallows every error — the
 * served Postgres payload is never affected.
 */
export async function compareDepositBonusOverview(
  period: InsightsRewardsPeriod,
  pgValues: {
    totalCost: number;
    count: number;
    uniqueClaimants: number;
    depositors: number;
    max: number;
  },
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_deposit_bonus_overview");
    if (mode !== "comparison") return;

    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getDepositBonusOverviewFromClickHouse(period, blacklist);
    });

    const drift = computeDrift(
      {
        totalCost: pgValues.totalCost,
        count: pgValues.count,
        uniqueClaimants: pgValues.uniqueClaimants,
        depositors: pgValues.depositors,
        max: pgValues.max,
      },
      {
        totalCost: ch.totalCost,
        count: ch.count,
        uniqueClaimants: ch.uniqueClaimants,
        depositors: ch.depositors,
        max: ch.max,
      },
      ["totalCost", "max"],
    );
    logComparison(`insights.deposit_bonus.overview[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_deposit_bonus_overview",
      "comparison failed (ignored)",
      err,
    );
  }
}
