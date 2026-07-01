import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import {
  kpiWindowToCutoff,
  type DashboardKpiWindow,
} from "@/lib/queries/dashboard-period";
import { toNumber } from "@/lib/utils/decimal";

/**
 * Dashboard "today" cash-flow KPIs (Deposits + Withdrawals), read from the
 * ClickHouse prod game mirror (`packy_prod`, PeerDB CDC).
 *
 * PARITY with the canonical Postgres definition
 * (`getDashboardCashflowFromPostgres` in
 * `src/lib/queries/dashboard-cashflow-pg.ts`), which itself mirrors the
 * `calculateWindowedPnl` cash legs so the box reconciles with the "P&L Today"
 * tile:
 *   • Deposits  = SUM(amount) of ledger_transactions WHERE type='deposit'
 *                 AND status='completed' AND created_at >= cutoff,
 *                 scoped to real customers KEEPING creators
 *                 (role NOT IN ('admin','support') + excluded-users blacklist).
 *   • Withdrawals = card outflow + |manual withdrawals|, same scope:
 *       – card_wd  = SUM(total_value_usd) of card_withdrawal_requests WHERE
 *                    status IN ('completed','shipped') AND
 *                    COALESCE(shipped_at, completed_at) >= cutoff.
 *       – manual_wd = |SUM(amount)| of admin_balance_adjustment ledger rows
 *                    that DEBIT the balance (balance_after < balance_before)
 *                    tagged 'Manual withdrawal:%', created_at >= cutoff.
 *   Counts pair 1:1 (deposit tx; card + manual withdrawal tx).
 *
 * NOTE (2026-07-02): this twin previously scoped to
 * role NOT IN ('admin','support','creator') and omitted the manual_wd leg —
 * matching the OLD box definition that read LOWER than "P&L Today". It was
 * re-aligned to the creators-kept + manual-withdrawal cash-flow definition so
 * PG↔CH parity holds against the new PG slice. The twin stays DORMANT in prod
 * (ClickHouse creds absent → the surface is forced "off") until a fresh
 * cent/count-exact parity pass re-confirms it under the new definition.
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
  // Creators are KEPT (only admin/support dropped) — the cash-flow box
  // reconciles with the "P&L Today" tile, whose scope keeps creators. See
  // the module doc.
  return `real_users AS (
      SELECT id
      FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND role NOT IN ('admin','support')
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

  // Card-withdrawal outflow (completed/shipped card_withdrawal_requests).
  const cardWithdrawalsSql = `
    WITH ${realUsersCte(hasBlacklist)}
    SELECT
      toString(sum(cwr.total_value_usd)) AS withdrawals,
      toString(count())                  AS withdrawal_count
    FROM ${CH_DB}.public_card_withdrawal_requests AS cwr FINAL
    WHERE cwr._peerdb_is_deleted = 0
      AND cwr.status IN ('completed','shipped')
      AND cwr.user_id IN (SELECT id FROM real_users)
      AND coalesce(cwr.shipped_at, cwr.completed_at) >= {cutoff:DateTime64(6)}`;

  // Manual withdrawals — admin_balance_adjustment ledger rows that DEBIT the
  // balance and are tagged 'Manual withdrawal:%'. |SUM(amount)| (the amounts
  // are stored as negative debits). Mirrors the PG manual_wd leg so the box's
  // withdrawal total equals |manualWd| + cardWd, exactly like P&L Today.
  const manualWithdrawalsSql = `
    WITH ${realUsersCte(hasBlacklist)}
    SELECT
      toString(abs(sum(lt.amount))) AS withdrawals,
      toString(count())             AS withdrawal_count
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.type = 'admin_balance_adjustment'
      AND lt.balance_after < lt.balance_before
      AND lt.description ILIKE 'Manual withdrawal:%'
      AND lt.user_id IN (SELECT id FROM real_users)
      AND lt.created_at >= {cutoff:DateTime64(6)}`;

  const [dep, cardWd, manualWd] = await Promise.all([
    clickhouseRead.query<{ deposits: string; deposit_count: string }>({
      queryName: "dashboard.cashflow.deposits",
      sql: depositsSql,
      params,
    }),
    clickhouseRead.query<{ withdrawals: string; withdrawal_count: string }>({
      queryName: "dashboard.cashflow.cardWithdrawals",
      sql: cardWithdrawalsSql,
      params,
    }),
    clickhouseRead.query<{ withdrawals: string; withdrawal_count: string }>({
      queryName: "dashboard.cashflow.manualWithdrawals",
      sql: manualWithdrawalsSql,
      params,
    }),
  ]);

  const d = dep[0] ?? { deposits: "0", deposit_count: "0" };
  const c = cardWd[0] ?? { withdrawals: "0", withdrawal_count: "0" };
  const m = manualWd[0] ?? { withdrawals: "0", withdrawal_count: "0" };
  return {
    deposits: toNumber(d.deposits),
    depositCount: Number(d.deposit_count),
    // Card + manual withdrawals — the exact composition of the PG slice and
    // calculateWindowedPnl's `withdrawals` total.
    withdrawals: toNumber(c.withdrawals) + toNumber(m.withdrawals),
    withdrawalCount: Number(c.withdrawal_count) + Number(m.withdrawal_count),
  };
}
