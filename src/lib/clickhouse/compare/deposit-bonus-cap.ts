import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { DepositBonusCapAnalysis } from "@/lib/queries/insights-rewards/deposit-bonus/cap-analysis";
import type { DepositBonusRatioDistribution } from "@/lib/queries/insights-rewards/deposit-bonus/cohort";

import { getDepositBonusCapAnalysisFromClickHouse } from "../queries/insights-rewards/deposit-bonus/cap-analysis";
import { getDepositBonusRatioDistributionFromClickHouse } from "../queries/insights-rewards/deposit-bonus/ratio-distribution";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison modules for the deposit-bonus Cap & Ratio tab.
 * Follow the canonical template (see `compare/dashboard-cashflow.ts`): no-op
 * unless the surface is in `comparison` mode, run the verified ClickHouse twin
 * with the SAME period + blacklist, reduce both engines to flat GATED scalars
 * (counts exact, money within half a cent) and log drift. Percentile/AVG-derived
 * fields (capHitRate, mean/median ratio) are NOT gated — PG `PERCENTILE_CONT`/
 * numeric AVG cannot be reproduced bit-exactly on CH Float64. Never throws.
 */

const sum = <T>(rows: readonly T[], pick: (r: T) => number): number =>
  rows.reduce((acc, r) => acc + pick(r), 0);

function reduceCap(v: DepositBonusCapAnalysis): Record<string, number> {
  return {
    capValue: v.capValue,
    capHits: v.capHits,
    uniqueCapHitters: v.uniqueCapHitters,
    histCount: sum(v.amountDistribution, (b) => b.count),
    histVolume: sum(v.amountDistribution, (b) => b.volume),
    dailyDays: v.dailyCapHitRate.length,
    dailyBonuses: sum(v.dailyCapHitRate, (d) => d.bonuses),
    dailyHits: sum(v.dailyCapHitRate, (d) => d.capHits),
    topHitterRows: v.topCapHitters.length,
    topHitterHits: sum(v.topCapHitters, (r) => r.capHits),
    topHitterBonus: sum(v.topCapHitters, (r) => r.totalBonus),
    biggestRows: v.biggestCapDeposits.length,
    biggestDeposit: sum(v.biggestCapDeposits, (r) => r.depositUsd),
  };
}

export async function compareDepositBonusCapAnalysis(
  period: InsightsRewardsPeriod,
  pgValues: DepositBonusCapAnalysis,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_deposit_bonus_cap_analysis");
    if (mode !== "comparison") return;
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getDepositBonusCapAnalysisFromClickHouse(period, blacklist);
    });
    const drift = computeDrift(reduceCap(pgValues), reduceCap(ch), [
      "capValue",
      "histVolume",
      "topHitterBonus",
      "biggestDeposit",
    ]);
    logComparison(`insights.deposit_bonus.cap_analysis[${period}]`, drift, durationMs);
  } catch (err) {
    logError("clickhouse.compare.insights_deposit_bonus_cap_analysis", "comparison failed (ignored)", err);
  }
}

function reduceRatio(v: DepositBonusRatioDistribution): Record<string, number> {
  const out: Record<string, number> = { totalDeposits: v.totalDeposits };
  v.ratioBuckets.forEach((b, i) => {
    out[`b${i}_count`] = b.count;
    out[`b${i}_volume`] = b.volume;
  });
  return out;
}

export async function compareDepositBonusRatioDistribution(
  period: InsightsRewardsPeriod,
  pgValues: DepositBonusRatioDistribution,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_deposit_bonus_ratio_distribution");
    if (mode !== "comparison") return;
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getDepositBonusRatioDistributionFromClickHouse(period, blacklist);
    });
    const moneyFields = pgValues.ratioBuckets.map((_, i) => `b${i}_volume`);
    const drift = computeDrift(reduceRatio(pgValues), reduceRatio(ch), moneyFields);
    logComparison(`insights.deposit_bonus.ratio_distribution[${period}]`, drift, durationMs);
  } catch (err) {
    logError("clickhouse.compare.insights_deposit_bonus_ratio_distribution", "comparison failed (ignored)", err);
  }
}
