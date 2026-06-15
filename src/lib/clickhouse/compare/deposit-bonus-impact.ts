import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type {
  DepositBonusCapHitterCohorts,
  DepositBonusCapHitters,
  DepositBonusDepositFrequency,
  DepositBonusDepositSizeDistribution,
  DepositBonusPostCapBehavior,
  DepositBonusTimeBetween,
  DepositBonusToWagerSegments,
} from "@/lib/queries/insights-rewards/deposit-bonus/impact";

import {
  getDepositBonusCapHitterCohortsFromClickHouse,
  getDepositBonusCapHittersFromClickHouse,
  getDepositBonusDepositFrequencyFromClickHouse,
  getDepositBonusDepositSizeDistributionFromClickHouse,
  getDepositBonusPostCapBehaviorFromClickHouse,
  getDepositBonusTimeBetweenFromClickHouse,
  getDepositBonusToWagerSegmentsFromClickHouse,
} from "../queries/insights-rewards/deposit-bonus/impact";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison modules for the deposit-bonus Impact tab (7 lenses).
 * Canonical template: gated, run the verified CH twin with the SAME args +
 * blacklist, reduce to flat GATED scalars, log drift. Percentile/AVG-derived
 * fields (medians, p25/p75, avg-per-day) are NOT gated. Never throws.
 */

const sum = <T>(rows: readonly T[], pick: (r: T) => number): number =>
  rows.reduce((acc, r) => acc + pick(r), 0);

function reduceFrequency(v: DepositBonusDepositFrequency): Record<string, number> {
  const out: Record<string, number> = { totalUserDays: v.totalUserDays, totalUsers: v.totalUsers };
  v.buckets.forEach((b, i) => {
    out[`b${i}_userDays`] = b.userDays;
  });
  return out;
}

export async function compareDepositBonusDepositFrequency(
  period: InsightsRewardsPeriod,
  pgValues: DepositBonusDepositFrequency,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_deposit_bonus_impact_frequency");
    if (mode !== "comparison") return;
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getDepositBonusDepositFrequencyFromClickHouse(period, blacklist);
    });
    const drift = computeDrift(reduceFrequency(pgValues), reduceFrequency(ch), []);
    logComparison(`insights.deposit_bonus.impact.frequency[${period}]`, drift, durationMs);
  } catch (err) {
    logError("clickhouse.compare.insights_deposit_bonus_impact_frequency", "comparison failed (ignored)", err);
  }
}

function reduceSize(v: DepositBonusDepositSizeDistribution): Record<string, number> {
  const out: Record<string, number> = {
    totalDeposits: v.totalDeposits,
    totalVolume: v.totalVolume,
    largeDepositCount: v.largeDepositCount,
    largeDepositVolume: v.largeDepositVolume,
  };
  v.buckets.forEach((b, i) => {
    out[`b${i}_count`] = b.count;
    out[`b${i}_volume`] = b.volume;
  });
  return out;
}

export async function compareDepositBonusDepositSizeDistribution(
  period: InsightsRewardsPeriod,
  pgValues: DepositBonusDepositSizeDistribution,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_deposit_bonus_impact_size");
    if (mode !== "comparison") return;
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getDepositBonusDepositSizeDistributionFromClickHouse(period, blacklist);
    });
    const moneyFields = ["totalVolume", "largeDepositVolume", ...pgValues.buckets.map((_, i) => `b${i}_volume`)];
    const drift = computeDrift(reduceSize(pgValues), reduceSize(ch), moneyFields);
    logComparison(`insights.deposit_bonus.impact.size[${period}]`, drift, durationMs);
  } catch (err) {
    logError("clickhouse.compare.insights_deposit_bonus_impact_size", "comparison failed (ignored)", err);
  }
}

function reduceCapHitters(v: DepositBonusCapHitters): Record<string, number> {
  return {
    capValue: v.capValue,
    distinctCapHitters: v.distinctCapHitters,
    totalDepositors: v.totalDepositors,
    combinedWager: v.combinedWager,
    combinedGgr: v.combinedGgr,
    totalDepositorWager: v.totalDepositorWager,
    rowCount: v.rows.length,
    rowCapHits: sum(v.rows, (r) => r.capHits),
    rowDeposit: sum(v.rows, (r) => r.depositTotal),
    rowWager: sum(v.rows, (r) => r.wagerTotal),
    rowPayout: sum(v.rows, (r) => r.payoutTotal),
    rowBonus: sum(v.rows, (r) => r.bonusTotal),
  };
}

export async function compareDepositBonusCapHitters(
  period: InsightsRewardsPeriod,
  pgValues: DepositBonusCapHitters,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_deposit_bonus_impact_cap_hitters");
    if (mode !== "comparison") return;
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getDepositBonusCapHittersFromClickHouse(period, blacklist);
    });
    const drift = computeDrift(reduceCapHitters(pgValues), reduceCapHitters(ch), [
      "capValue",
      "combinedWager",
      "combinedGgr",
      "totalDepositorWager",
      "rowDeposit",
      "rowWager",
      "rowPayout",
      "rowBonus",
    ]);
    logComparison(`insights.deposit_bonus.impact.cap_hitters[${period}]`, drift, durationMs);
  } catch (err) {
    logError("clickhouse.compare.insights_deposit_bonus_impact_cap_hitters", "comparison failed (ignored)", err);
  }
}

function reduceTimeBetween(v: DepositBonusTimeBetween): Record<string, number> {
  const out: Record<string, number> = { totalGaps: v.totalGaps };
  v.buckets.forEach((b, i) => {
    out[`b${i}_count`] = b.count;
  });
  return out;
}

export async function compareDepositBonusTimeBetween(
  period: InsightsRewardsPeriod,
  pgValues: DepositBonusTimeBetween,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_deposit_bonus_impact_time_between");
    if (mode !== "comparison") return;
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getDepositBonusTimeBetweenFromClickHouse(period, blacklist);
    });
    const drift = computeDrift(reduceTimeBetween(pgValues), reduceTimeBetween(ch), []);
    logComparison(`insights.deposit_bonus.impact.time_between[${period}]`, drift, durationMs);
  } catch (err) {
    logError("clickhouse.compare.insights_deposit_bonus_impact_time_between", "comparison failed (ignored)", err);
  }
}

function reduceSegments(v: DepositBonusToWagerSegments): Record<string, number> {
  const out: Record<string, number> = {};
  v.segments.forEach((s, i) => {
    out[`s${i}_users`] = s.users;
    out[`s${i}_avgBonus`] = s.avgBonus;
    out[`s${i}_avgWager`] = s.avgWager;
  });
  return out;
}

export async function compareDepositBonusToWagerSegments(
  period: InsightsRewardsPeriod,
  pgValues: DepositBonusToWagerSegments,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_deposit_bonus_impact_bonus_wager");
    if (mode !== "comparison") return;
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getDepositBonusToWagerSegmentsFromClickHouse(period, blacklist);
    });
    const moneyFields = pgValues.segments.flatMap((_, i) => [`s${i}_avgBonus`, `s${i}_avgWager`]);
    const drift = computeDrift(reduceSegments(pgValues), reduceSegments(ch), moneyFields);
    logComparison(`insights.deposit_bonus.impact.bonus_wager[${period}]`, drift, durationMs);
  } catch (err) {
    logError("clickhouse.compare.insights_deposit_bonus_impact_bonus_wager", "comparison failed (ignored)", err);
  }
}

function reducePostCap(v: DepositBonusPostCapBehavior): Record<string, number> {
  return {
    capValue: v.capValue,
    capHitters: v.capHitters,
    keptDepositing: v.keptDepositing,
    stopped: v.stopped,
    postCapDepositsNoBonus: v.postCapDepositsNoBonus,
    postCapDepositsTotal: v.postCapDepositsTotal,
  };
}

export async function compareDepositBonusPostCapBehavior(
  period: InsightsRewardsPeriod,
  pgValues: DepositBonusPostCapBehavior,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_deposit_bonus_impact_post_cap");
    if (mode !== "comparison") return;
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getDepositBonusPostCapBehaviorFromClickHouse(period, blacklist);
    });
    const drift = computeDrift(reducePostCap(pgValues), reducePostCap(ch), ["capValue"]);
    logComparison(`insights.deposit_bonus.impact.post_cap[${period}]`, drift, durationMs);
  } catch (err) {
    logError("clickhouse.compare.insights_deposit_bonus_impact_post_cap", "comparison failed (ignored)", err);
  }
}

function reduceCohorts(v: DepositBonusCapHitterCohorts): Record<string, number> {
  return {
    capValue: v.capValue,
    new_users: v.newCohort.users,
    new_capHits: v.newCohort.capHits,
    new_deposit: v.newCohort.depositTotal,
    new_wager: v.newCohort.wagerTotal,
    ret_users: v.returningCohort.users,
    ret_capHits: v.returningCohort.capHits,
    ret_deposit: v.returningCohort.depositTotal,
    ret_wager: v.returningCohort.wagerTotal,
  };
}

export async function compareDepositBonusCapHitterCohorts(
  period: InsightsRewardsPeriod,
  pgValues: DepositBonusCapHitterCohorts,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_deposit_bonus_impact_cohorts");
    if (mode !== "comparison") return;
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getDepositBonusCapHitterCohortsFromClickHouse(period, blacklist);
    });
    const drift = computeDrift(reduceCohorts(pgValues), reduceCohorts(ch), [
      "capValue",
      "new_deposit",
      "new_wager",
      "ret_deposit",
      "ret_wager",
    ]);
    logComparison(`insights.deposit_bonus.impact.cohorts[${period}]`, drift, durationMs);
  } catch (err) {
    logError("clickhouse.compare.insights_deposit_bonus_impact_cohorts", "comparison failed (ignored)", err);
  }
}
