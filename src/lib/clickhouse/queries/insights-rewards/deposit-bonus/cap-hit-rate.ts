import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";

import { CH_DB, toNumber } from "../../_shared";
import { cutoffClause, depositBonusCutoff, depositBonusScopeCte } from "./_shared";

/**
 * ClickHouse twin of the lightweight cap-hit-rate rollup
 * (`getDepositBonusCapHitRate` → `computeCapHitRate` in
 * `src/lib/queries/insights-rewards/deposit-bonus/cap-analysis.ts`).
 *
 * The deposit-bonus cap is configured in the game backend, so it is derived
 * EMPIRICALLY as `MAX(ABS(amount))` over the window; "cap hits" are the rows
 * whose `ABS(amount)` equals that max. Mirrors the PG twin's two small scans:
 *   • capValue   = MAX(ABS(amount))             type='deposit_bonus'
 *   • totalCount = COUNT(*)                      type='deposit_bonus'
 *   • capHits    = COUNT(*) WHERE ABS(amount)=cap
 * all `status='completed'`, 2-role customer scope + blacklist, same
 * `windowDateFilter` cutoff. The empirical cap is fixed to 2 decimals
 * (`toFixed(2)` PG-side → `toDecimal128(cap, 2)` CH-side) so the equality test
 * is cent-exact.
 */

export type DepositBonusCapHitRateCh = {
  capValue: number;
  capHits: number;
  totalCount: number;
};

export async function getDepositBonusCapHitRateFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<DepositBonusCapHitRateCh> {
  const hasBlacklist = blacklist.length > 0;
  const cutoff = depositBonusCutoff(period, now);
  const scope = depositBonusScopeCte(hasBlacklist);
  const params: Record<string, unknown> = { blacklist, cutoff };

  const capRows = await clickhouseRead.query<{
    cap: string;
    cnt: string;
  }>({
    queryName: "insights.deposit_bonus.cap_hit_rate.cap",
    sql: `
      WITH ${scope}
      SELECT
        toString(max(abs(lt.amount))) AS cap,
        toString(count())             AS cnt
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      WHERE lt._peerdb_is_deleted = 0
        AND lt.status = 'completed'
        AND lt.type = 'deposit_bonus'
        AND lt.user_id IN (SELECT id FROM real_users)
        ${cutoffClause(cutoff, "lt")}`,
    params,
  });

  const capValue = toNumber(capRows[0]?.cap ?? "0");
  const totalCount = Number(capRows[0]?.cnt ?? "0");

  if (capValue <= 0 || totalCount === 0) {
    return { capValue: 0, capHits: 0, totalCount };
  }

  const capLiteral = capValue.toFixed(2);
  const hitsRows = await clickhouseRead.query<{ hits: string }>({
    queryName: "insights.deposit_bonus.cap_hit_rate.hits",
    sql: `
      WITH ${scope}
      SELECT toString(count()) AS hits
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      WHERE lt._peerdb_is_deleted = 0
        AND lt.status = 'completed'
        AND lt.type = 'deposit_bonus'
        AND lt.user_id IN (SELECT id FROM real_users)
        AND abs(lt.amount) = toDecimal128({cap:String}, 2)
        ${cutoffClause(cutoff, "lt")}`,
    params: { ...params, cap: capLiteral },
  });

  return {
    capValue,
    capHits: Number(hitsRows[0]?.hits ?? "0"),
    totalCount,
  };
}
