import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { DepositBonusSuspicious } from "@/lib/queries/insights-rewards/deposit-bonus/suspicious";
import type { DepositBonusTopSpender } from "@/lib/queries/insights-rewards/deposit-bonus/top-spenders";

import { getDepositBonusSuspiciousFromClickHouse } from "../queries/insights-rewards/deposit-bonus/suspicious";
import { getDepositBonusTopSpendersFromClickHouse } from "../queries/insights-rewards/deposit-bonus/top-spenders";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison modules for the deposit-bonus Risk tab. Canonical
 * template (see `compare/dashboard-cashflow.ts`): gated, run the verified CH twin
 * with the SAME args + blacklist, reduce the ranked lists to row-count + per-leg
 * Σ scalars, log drift. `hoursToWithdraw` (derived float) is not gated. The
 * sharedFingerprint list is empty on both engines (fingerprints mirror empty —
 * disclosed). Never throws.
 */

const sum = <T>(rows: readonly T[], pick: (r: T) => number): number =>
  rows.reduce((acc, r) => acc + pick(r), 0);

function reduceTopSpenders(rows: DepositBonusTopSpender[]): Record<string, number> {
  return {
    rowCount: rows.length,
    bonusTotal: sum(rows, (r) => r.bonusTotal),
    bonusCount: sum(rows, (r) => r.bonusCount),
    lifetimeBonusTotal: sum(rows, (r) => r.lifetimeBonusTotal),
    lifetimeBonusCount: sum(rows, (r) => r.lifetimeBonusCount),
    depositTotal: sum(rows, (r) => r.depositTotal),
    wagerTotal: sum(rows, (r) => r.wagerTotal),
    payoutTotal: sum(rows, (r) => r.payoutTotal),
  };
}

export async function compareDepositBonusTopSpenders(
  period: InsightsRewardsPeriod,
  pgValues: DepositBonusTopSpender[],
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_deposit_bonus_top_spenders");
    if (mode !== "comparison") return;
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getDepositBonusTopSpendersFromClickHouse(period, blacklist);
    });
    const drift = computeDrift(reduceTopSpenders(pgValues), reduceTopSpenders(ch), [
      "bonusTotal",
      "lifetimeBonusTotal",
      "depositTotal",
      "wagerTotal",
      "payoutTotal",
    ]);
    logComparison(`insights.deposit_bonus.top_spenders[${period}]`, drift, durationMs);
  } catch (err) {
    logError("clickhouse.compare.insights_deposit_bonus_top_spenders", "comparison failed (ignored)", err);
  }
}

function reduceSuspicious(v: DepositBonusSuspicious): Record<string, number> {
  return {
    withdrew_count: v.withdrewAfterBonus.length,
    withdrew_bonus: sum(v.withdrewAfterBonus, (r) => r.bonusInWindow),
    withdrew_amount: sum(v.withdrewAfterBonus, (r) => r.withdrawAmount),
    noWager_count: v.noWager.length,
    noWager_bonus: sum(v.noWager, (r) => r.bonusInWindow),
    shared_count: v.sharedFingerprint.length,
    shared_bonus: sum(v.sharedFingerprint, (r) => r.bonusInWindow),
  };
}

export async function compareDepositBonusSuspicious(
  period: InsightsRewardsPeriod,
  pgValues: DepositBonusSuspicious,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_deposit_bonus_suspicious");
    if (mode !== "comparison") return;
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getDepositBonusSuspiciousFromClickHouse(period, blacklist);
    });
    const drift = computeDrift(reduceSuspicious(pgValues), reduceSuspicious(ch), [
      "withdrew_bonus",
      "withdrew_amount",
      "noWager_bonus",
      "shared_bonus",
    ]);
    logComparison(`insights.deposit_bonus.suspicious[${period}]`, drift, durationMs);
  } catch (err) {
    logError("clickhouse.compare.insights_deposit_bonus_suspicious", "comparison failed (ignored)", err);
  }
}
