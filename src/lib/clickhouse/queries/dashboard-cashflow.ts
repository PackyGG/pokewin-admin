import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import {
  kpiWindowToCutoff,
  type DashboardKpiWindow,
} from "@/lib/queries/dashboard-period";
import { toNumber } from "@/lib/utils/decimal";

/**
 * Phase 1 PoC — Dashboard "today" cash-flow KPIs (Deposits + Withdrawals),
 * read from the ClickHouse prod game mirror (`packy_prod`, PeerDB CDC).
 *
 * PARITY with the canonical Postgres definition (period-window-kpis.ts):
 *   • Deposits  = SUM(amount) of ledger_transactions WHERE type='deposit'
 *                 AND status='completed' AND created_at >= cutoff,
 *                 scoped to real customers (role NOT IN admin/support/creator
 *                 + excluded-users blacklist).
 *   • Withdrawals = SUM(total_value_usd) of card_withdrawal_requests WHERE
 *                 status IN ('completed','shipped')
 *                 AND COALESCE(completed_at, shipped_at) >= cutoff, same scope.
 *
 * ClickHouse correctness (PeerDB / SharedReplacingMergeTree mirrors):
 *   • Dedup latest row per id with FINAL.
 *   • Drop soft-deleted rows with `_peerdb_is_deleted = 0`.
 *   • Money stays Decimal end-to-end (returned as a string, parsed via toNumber)
 *     — never Float — so parity is exact to the cent.
 *
 * The blacklist is passed IN by the caller (fetched from the admin DB via
 * getExcludedUserIds) so this module never imports a Postgres client — it is a
 * pure ClickHouse read. The cutoff reuses the SAME canonical helper the
 * Postgres path uses, guaranteeing an identical UTC-midnight ("today") window.
 */

export type DashboardCashflowCh = {
  deposits: number;
  depositCount: number;
  withdrawals: number;
  withdrawalCount: number;
};

const CH_DB = "packy_prod";

/** JS Date (UTC) → ClickHouse DateTime64 literal 'YYYY-MM-DD HH:MM:SS.fff'. */
function chDateTime(d: Date): string {
  return d.toISOString().replace("T", " ").replace("Z", "");
}

function realUsersCte(hasBlacklist: boolean): string {
  return `real_users AS (
      SELECT id
      FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND role NOT IN ('admin','support','creator')
        ${hasBlacklist ? "AND id NOT IN {blacklist:Array(String)}" : ""}
    )`;
}

export async function getDashboardCashflowFromClickHouse(
  window: DashboardKpiWindow,
  blacklist: string[],
  now: Date = new Date(),
): Promise<DashboardCashflowCh> {
  const cutoff = chDateTime(kpiWindowToCutoff(window, now));
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = { cutoff, blacklist };

  const depositsSql = `
    WITH ${realUsersCte(hasBlacklist)}
    SELECT
      toString(sum(lt.amount)) AS deposits,
      toString(count())        AS deposit_count
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.type = 'deposit'
      AND lt.user_id IN (SELECT id FROM real_users)
      AND lt.created_at >= {cutoff:DateTime64(6)}`;

  const withdrawalsSql = `
    WITH ${realUsersCte(hasBlacklist)}
    SELECT
      toString(sum(cwr.total_value_usd)) AS withdrawals,
      toString(count())                  AS withdrawal_count
    FROM ${CH_DB}.public_card_withdrawal_requests AS cwr FINAL
    WHERE cwr._peerdb_is_deleted = 0
      AND cwr.status IN ('completed','shipped')
      AND cwr.user_id IN (SELECT id FROM real_users)
      AND coalesce(cwr.completed_at, cwr.shipped_at) >= {cutoff:DateTime64(6)}`;

  const [dep, wd] = await Promise.all([
    clickhouseRead.query<{ deposits: string; deposit_count: string }>({
      queryName: "dashboard.cashflow.deposits",
      sql: depositsSql,
      params,
    }),
    clickhouseRead.query<{ withdrawals: string; withdrawal_count: string }>({
      queryName: "dashboard.cashflow.withdrawals",
      sql: withdrawalsSql,
      params,
    }),
  ]);

  const d = dep[0] ?? { deposits: "0", deposit_count: "0" };
  const w = wd[0] ?? { withdrawals: "0", withdrawal_count: "0" };
  return {
    deposits: toNumber(d.deposits),
    depositCount: Number(d.deposit_count),
    withdrawals: toNumber(w.withdrawals),
    withdrawalCount: Number(w.withdrawal_count),
  };
}
