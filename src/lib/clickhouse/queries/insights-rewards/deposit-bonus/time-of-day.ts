import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";

import { CH_DB, toNumber } from "../../_shared";
import { cutoffClause, depositBonusCutoff, depositBonusScopeCte } from "./_shared";

/**
 * ClickHouse twin of the deposit-bonus time-of-day distribution
 * (`getDepositBonusTimeOfDay` → `computeTimeOfDay` in
 * `src/lib/queries/insights-rewards/deposit-bonus/behavior.ts`).
 *
 * The full PG helper buckets bonuses by UTC hour-of-day + day-of-week; this
 * twin mirrors the cent-exact / count-exact GRAND TOTALS those buckets sum to
 * (the underlying set, which is what a drift gate validates):
 *   • totalCount  = COUNT(*)          type='deposit_bonus'
 *   • totalVolume = SUM(ABS(amount))  type='deposit_bonus'
 * status='completed', 2-role customer scope + blacklist, same
 * `windowDateFilter` cutoff.
 */

export type DepositBonusTimeOfDayCh = {
  totalCount: number;
  totalVolume: number;
};

export async function getDepositBonusTimeOfDayFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<DepositBonusTimeOfDayCh> {
  const hasBlacklist = blacklist.length > 0;
  const cutoff = depositBonusCutoff(period, now);
  const scope = depositBonusScopeCte(hasBlacklist);
  const params: Record<string, unknown> = { blacklist, cutoff };

  const rows = await clickhouseRead.query<{ cnt: string; volume: string }>({
    queryName: "insights.deposit_bonus.time_of_day.totals",
    sql: `
      WITH ${scope}
      SELECT
        toString(count())             AS cnt,
        toString(sum(abs(lt.amount))) AS volume
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      WHERE lt._peerdb_is_deleted = 0
        AND lt.status = 'completed'
        AND lt.type = 'deposit_bonus'
        AND lt.user_id IN (SELECT id FROM real_users)
        ${cutoffClause(cutoff, "lt")}`,
    params,
  });

  return {
    totalCount: Number(rows[0]?.cnt ?? "0"),
    totalVolume: toNumber(rows[0]?.volume ?? "0"),
  };
}
