import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { DepositBonusDailyRow } from "@/lib/queries/insights-rewards/deposit-bonus/daily-breakdown";

import { getDepositBonusDailyBreakdownFromClickHouse } from "../queries/insights-rewards/deposit-bonus/daily-breakdown";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the deposit-bonus daily breakdown table
 * (Overview tab). Canonical template: gated, run the verified CH twin with the
 * SAME period + blacklist, reduce the per-day series to row-count + per-column Σ
 * scalars, log drift. The per-day derived ratios (attachRate, avgBonus, …) are
 * recomputed identically in TS so only the source columns are gated. Never
 * throws.
 */

const sum = <T>(rows: readonly T[], pick: (r: T) => number): number =>
  rows.reduce((acc, r) => acc + pick(r), 0);

function reduceDaily(rows: DepositBonusDailyRow[]): Record<string, number> {
  return {
    rowCount: rows.length,
    depositCount: sum(rows, (r) => r.depositCount),
    depositVolume: sum(rows, (r) => r.depositVolume),
    depositWithBonusCount: sum(rows, (r) => r.depositWithBonusCount),
    bonusCount: sum(rows, (r) => r.bonusCount),
    bonusVolume: sum(rows, (r) => r.bonusVolume),
    uniqueClaimants: sum(rows, (r) => r.uniqueClaimants),
  };
}

export async function compareDepositBonusDailyBreakdown(
  period: InsightsRewardsPeriod,
  pgValues: DepositBonusDailyRow[],
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_deposit_bonus_daily_breakdown");
    if (mode !== "comparison") return;
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getDepositBonusDailyBreakdownFromClickHouse(period, blacklist);
    });
    const drift = computeDrift(reduceDaily(pgValues), reduceDaily(ch), ["depositVolume", "bonusVolume"]);
    logComparison(`insights.deposit_bonus.daily_breakdown[${period}]`, drift, durationMs);
  } catch (err) {
    logError("clickhouse.compare.insights_deposit_bonus_daily_breakdown", "comparison failed (ignored)", err);
  }
}
