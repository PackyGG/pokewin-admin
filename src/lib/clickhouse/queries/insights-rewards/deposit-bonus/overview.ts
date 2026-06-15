import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";

import { CH_DB, toNumber } from "../../_shared";
import { cutoffClause, depositBonusCutoff, depositBonusScopeCte } from "./_shared";

/**
 * ClickHouse twin of the deposit-bonus Overview headline rollup
 * (`getDepositBonusOverview` → `computeOverview` in
 * `src/lib/queries/insights-rewards/deposit-bonus/overview.ts`).
 *
 * Mirrors EXACTLY the PG headline aggregates:
 *   • totalCost       = SUM(ABS(amount))           type='deposit_bonus'
 *   • count           = COUNT(*)                   type='deposit_bonus'
 *   • uniqueClaimants = COUNT(DISTINCT user_id)    type='deposit_bonus'
 *   • max             = MAX(ABS(amount))           type='deposit_bonus'
 *   • depositors      = COUNT(DISTINCT user_id)    type='deposit'  (same window+scope)
 * all rows `status='completed'`, scoped to the 2-role customer set + blacklist,
 * bounded by the same `windowDateFilter` cutoff. The median / daily series /
 * prior-window terms are NOT mirrored here — the comparison validates the
 * cent-exact / count-exact scalar headline (interpolated percentile parity is
 * out of scope for the drift gate).
 */

export type DepositBonusOverviewCh = {
  totalCost: number;
  count: number;
  uniqueClaimants: number;
  depositors: number;
  max: number;
};

export async function getDepositBonusOverviewFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<DepositBonusOverviewCh> {
  const hasBlacklist = blacklist.length > 0;
  const cutoff = depositBonusCutoff(period, now);
  const scope = depositBonusScopeCte(hasBlacklist);
  const params: Record<string, unknown> = { blacklist, cutoff };

  const rollupSql = `
    WITH ${scope}
    SELECT
      toString(sum(abs(lt.amount)))   AS total,
      toString(count())               AS cnt,
      toString(uniqExact(lt.user_id)) AS claimants,
      toString(max(abs(lt.amount)))   AS max_amount
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.type = 'deposit_bonus'
      AND lt.user_id IN (SELECT id FROM real_users)
      ${cutoffClause(cutoff, "lt")}`;

  const depositorsSql = `
    WITH ${scope}
    SELECT toString(uniqExact(lt.user_id)) AS depositors
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.type = 'deposit'
      AND lt.user_id IN (SELECT id FROM real_users)
      ${cutoffClause(cutoff, "lt")}`;

  const [rollup, depositors] = await Promise.all([
    clickhouseRead.query<{
      total: string;
      cnt: string;
      claimants: string;
      max_amount: string;
    }>({
      queryName: "insights.deposit_bonus.overview.rollup",
      sql: rollupSql,
      params,
    }),
    clickhouseRead.query<{ depositors: string }>({
      queryName: "insights.deposit_bonus.overview.depositors",
      sql: depositorsSql,
      params,
    }),
  ]);

  const r = rollup[0] ?? {
    total: "0",
    cnt: "0",
    claimants: "0",
    max_amount: "0",
  };
  return {
    totalCost: toNumber(r.total),
    count: Number(r.cnt),
    uniqueClaimants: Number(r.claimants),
    depositors: Number(depositors[0]?.depositors ?? "0"),
    max: toNumber(r.max_amount),
  };
}
