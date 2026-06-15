import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";

import { CH_DB, toNumber } from "../../_shared";
import { cutoffClause, depositBonusCutoff, depositBonusScopeCte } from "./_shared";

/**
 * ClickHouse twin of the deposit-bonus geo/source total
 * (`getDepositBonusGeoSource` → `computeGeoSource` in
 * `src/lib/queries/insights-rewards/deposit-bonus/geo-source.ts`).
 *
 * The full PG helper also returns the top-N country / signup-source
 * breakdowns; this twin mirrors the cent-exact reference total the share math
 * is built on:
 *   • totalCost = SUM(ABS(amount))   type='deposit_bonus', status='completed',
 *                 2-role customer scope + blacklist, same `windowDateFilter`
 *                 cutoff.
 * (The PG total joins `"user"` for the role filter; the CH twin applies the
 * identical scope via the `real_users` membership test — same result set.)
 */

export type DepositBonusGeoSourceCh = {
  totalCost: number;
};

export async function getDepositBonusGeoSourceFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<DepositBonusGeoSourceCh> {
  const hasBlacklist = blacklist.length > 0;
  const cutoff = depositBonusCutoff(period, now);
  const scope = depositBonusScopeCte(hasBlacklist);
  const params: Record<string, unknown> = { blacklist, cutoff };

  const rows = await clickhouseRead.query<{ total: string }>({
    queryName: "insights.deposit_bonus.geo_source.total",
    sql: `
      WITH ${scope}
      SELECT toString(sum(abs(lt.amount))) AS total
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      WHERE lt._peerdb_is_deleted = 0
        AND lt.status = 'completed'
        AND lt.type = 'deposit_bonus'
        AND lt.user_id IN (SELECT id FROM real_users)
        ${cutoffClause(cutoff, "lt")}`,
    params,
  });

  return { totalCost: toNumber(rows[0]?.total ?? "0") };
}
