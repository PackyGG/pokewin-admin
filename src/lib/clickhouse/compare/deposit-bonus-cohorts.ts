import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type {
  DepositBonusNewVsReturning,
  DepositBonusRepeatClaimants,
  DepositBonusTimeToClaim,
} from "@/lib/queries/insights-rewards/deposit-bonus/behavior";
import type { DepositBonusCohortComparison } from "@/lib/queries/insights-rewards/deposit-bonus/cohort";

import { getDepositBonusCohortComparisonFromClickHouse } from "../queries/insights-rewards/deposit-bonus/cohort";
import { getDepositBonusNewVsReturningFromClickHouse } from "../queries/insights-rewards/deposit-bonus/new-vs-returning";
import { getDepositBonusRepeatClaimantsFromClickHouse } from "../queries/insights-rewards/deposit-bonus/repeat-claimants";
import { getDepositBonusTimeToClaimFromClickHouse } from "../queries/insights-rewards/deposit-bonus/time-to-claim";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison modules for the deposit-bonus Cohorts tab. Same
 * canonical template as `compare/dashboard-cashflow.ts`: gated, run the verified
 * CH twin with the SAME args + blacklist, reduce to flat GATED scalars, log
 * drift. Percentile/AVG-derived fields (median/p99 deposit, latency percentiles,
 * avgFirstDepositUsd, lift %) are NOT gated. Never throws.
 */

function reduceCohort(v: DepositBonusCohortComparison): Record<string, number> {
  return {
    totalDeposits: v.totalDeposits,
    with_count: v.withBonus.count,
    with_sum: v.withBonus.sum,
    with_users: v.withBonus.uniqueUsers,
    with_ret7: v.withBonus.retain7d,
    with_ret30: v.withBonus.retain30d,
    without_count: v.withoutBonus.count,
    without_sum: v.withoutBonus.sum,
    without_users: v.withoutBonus.uniqueUsers,
    without_ret7: v.withoutBonus.retain7d,
    without_ret30: v.withoutBonus.retain30d,
  };
}

export async function compareDepositBonusCohortComparison(
  period: InsightsRewardsPeriod,
  pgValues: DepositBonusCohortComparison,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_deposit_bonus_cohort");
    if (mode !== "comparison") return;
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getDepositBonusCohortComparisonFromClickHouse(period, blacklist);
    });
    const drift = computeDrift(reduceCohort(pgValues), reduceCohort(ch), ["with_sum", "without_sum"]);
    logComparison(`insights.deposit_bonus.cohort[${period}]`, drift, durationMs);
  } catch (err) {
    logError("clickhouse.compare.insights_deposit_bonus_cohort", "comparison failed (ignored)", err);
  }
}

function reduceNvr(v: DepositBonusNewVsReturning): Record<string, number> {
  return {
    new_users: v.newClaimants.users,
    new_bonus: v.newClaimants.totalBonus,
    new_ret7: v.newClaimants.retain7d,
    new_second: v.newClaimants.secondDeposit30dRate,
    ret_users: v.returningClaimants.users,
    ret_bonus: v.returningClaimants.totalBonus,
    ret_ret7: v.returningClaimants.retain7d,
    ret_second: v.returningClaimants.secondDeposit30dRate,
  };
}

export async function compareDepositBonusNewVsReturning(
  period: InsightsRewardsPeriod,
  pgValues: DepositBonusNewVsReturning,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_deposit_bonus_new_vs_returning");
    if (mode !== "comparison") return;
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getDepositBonusNewVsReturningFromClickHouse(period, blacklist);
    });
    const drift = computeDrift(reduceNvr(pgValues), reduceNvr(ch), ["new_bonus", "ret_bonus"]);
    logComparison(`insights.deposit_bonus.new_vs_returning[${period}]`, drift, durationMs);
  } catch (err) {
    logError("clickhouse.compare.insights_deposit_bonus_new_vs_returning", "comparison failed (ignored)", err);
  }
}

function reduceRepeat(v: DepositBonusRepeatClaimants): Record<string, number> {
  const out: Record<string, number> = { totalClaimants: v.totalClaimants, totalBonus: v.totalBonus };
  v.segments.forEach((s, i) => {
    out[`s${i}_users`] = s.users;
    out[`s${i}_bonus`] = s.totalBonus;
    out[`s${i}_wager`] = s.wagerInWindow;
  });
  return out;
}

export async function compareDepositBonusRepeatClaimants(
  period: InsightsRewardsPeriod,
  pgValues: DepositBonusRepeatClaimants,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_deposit_bonus_repeat_claimants");
    if (mode !== "comparison") return;
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getDepositBonusRepeatClaimantsFromClickHouse(period, blacklist);
    });
    const moneyFields = ["totalBonus", ...pgValues.segments.flatMap((_, i) => [`s${i}_bonus`, `s${i}_wager`])];
    const drift = computeDrift(reduceRepeat(pgValues), reduceRepeat(ch), moneyFields);
    logComparison(`insights.deposit_bonus.repeat_claimants[${period}]`, drift, durationMs);
  } catch (err) {
    logError("clickhouse.compare.insights_deposit_bonus_repeat_claimants", "comparison failed (ignored)", err);
  }
}

function reduceTtc(v: DepositBonusTimeToClaim): Record<string, number> {
  const out: Record<string, number> = { totalPaired: v.totalPaired };
  v.buckets.forEach((b, i) => {
    out[`b${i}_count`] = b.count;
  });
  return out;
}

export async function compareDepositBonusTimeToClaim(
  period: InsightsRewardsPeriod,
  pgValues: DepositBonusTimeToClaim,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_deposit_bonus_time_to_claim");
    if (mode !== "comparison") return;
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getDepositBonusTimeToClaimFromClickHouse(period, blacklist);
    });
    const drift = computeDrift(reduceTtc(pgValues), reduceTtc(ch), []);
    logComparison(`insights.deposit_bonus.time_to_claim[${period}]`, drift, durationMs);
  } catch (err) {
    logError("clickhouse.compare.insights_deposit_bonus_time_to_claim", "comparison failed (ignored)", err);
  }
}
