import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { CH_DB, chDateTime, toNumber, nonCreatorOwnerCh } from "../_shared";

/**
 * Phase 2B — single-UTC-day house-P&L breakdown SUMMARY, read from the
 * ClickHouse prod game mirror (`packy_prod`, PeerDB CDC).
 *
 * Twin of the canonical Postgres `getDailyPnlBreakdown`
 * (src/lib/queries/dashboard-daily-pnl-breakdown.ts) — the click-to-load
 * drilldown behind ONE bar of the dashboard Daily-P&L chart. Mirrors the PG
 * twin's SUMMARY (the six reconciling money terms) + each section's un-capped
 * row count for a SINGLE UTC calendar day D, so comparison mode can diff the
 * cent-exact summary + exact counts.
 *
 * IMPORTANT — this mirrors `getDailyPnlBreakdown` EXACTLY, which is a SIMPLER
 * per-day re-expression of the windowed-delta P&L formula than the 30-day
 * `getDailyPnl` chart leg: the breakdown's inventory/voucher legs read ONLY
 * `user_inventory` (obtained / sold|exchanged) and `vouchers`
 * (created / claimed) — it deliberately does NOT fold in the
 * `admin_balance_adjustment` inventory_removal / voucher_removal "wipe
 * correction" legs that `getDailyPnl` (and its CH twin `dashboard/daily-pnl.ts`)
 * carry. We therefore do NOT reuse that twin here; we replicate the breakdown's
 * own per-day aggregates so parity signals a real bug, not an intended formula
 * difference.
 *
 * Per-component event-date bucketing for day D = [D 00:00 UTC, D+1 00:00 UTC)
 * (the `since`/`until` range below, equivalent to PG `DATE(col) = D::date`
 * under TZ=UTC — no `toDate` timezone dependency):
 *   • ledger legs (deposits / manualWd / balanceChange) by created_at
 *   • card withdrawals by COALESCE(shipped_at, completed_at)
 *   • inventory obtained by obtained_at; disposed by COALESCE(sold_at, exchanged_at)
 *   • vouchers issued by created_at; claimed by claimed_at
 * then combined:
 *   pnl = deposits − (|manualWd| + cardWd) − balanceΔ − inventoryΔ − voucherΔ
 *
 * Scope mirrors the PG twin EXACTLY — 2-role (`role NOT IN ('admin','support')`,
 * creators KEPT) + the dynamic excluded-users blacklist (this is the global P&L
 * scope, NOT the creator-dropping wholesale `getMetricsScope`). The
 * `official_stream` + `remove_locked_balance` fake-balance adjustments are
 * carved out of the balance-change term (matches `statsExcludedAdjustmentSqlPredicate`).
 *
 * ClickHouse correctness: FINAL + `_peerdb_is_deleted = 0` on every table; money
 * stays Decimal (`toString(sum(...))` → `toNumber`, never Float); `if()`
 * zero-branches use `toDecimal128(0, 2)` (§5b); the blacklist is passed IN by the
 * caller so this module imports NO Postgres/Prisma client (direct or transitive).
 */

export type DailyPnlBreakdownSummaryCh = {
  /** YYYY-MM-DD (UTC) — the calendar day this drill covers. */
  date: string;
  deposits: number;
  withdrawals: number;
  balanceChange: number;
  inventoryChange: number;
  voucherChange: number;
  pnl: number;
  /** Un-capped row counts per section (match the PG `totalCount`s). */
  depositCount: number;
  withdrawalCount: number;
  balanceCount: number;
  inventoryCount: number;
  voucherCount: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** stats-excluded fake-balance carve-out (CH twin of `statsExcludedAdjustmentSqlPredicate`). */
const STATS_EXCLUDED_CH =
  `lt.type = 'admin_balance_adjustment' AND JSONExtractString(lt.metadata, 'adjustment_category') IN ('official_stream','remove_locked_balance')`;

/** 2-role scope CTE (creators KEPT) + optional blacklist — mirrors the PG twin. */
function realUsersCte(hasBlacklist: boolean): string {
  return `real_users AS (
      SELECT id
      FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND role NOT IN ('admin','support')
        ${hasBlacklist ? "AND id NOT IN {blacklist:Array(String)}" : ""}
    )`;
}

type LedgerRow = {
  deposits: string;
  deposit_count: string;
  manual_wd: string;
  manual_wd_count: string;
  balance_change: string;
  balance_count: string;
};
type CardRow = { card_wd: string; card_count: string };
type InvRow = {
  obtained: string;
  obtained_count: string;
  disposed: string;
  disposed_count: string;
};
type VchRow = {
  issued: string;
  issued_count: string;
  claimed: string;
  claimed_count: string;
};

export async function getDailyPnlBreakdownFromClickHouse(
  dayUtc: string,
  blacklist: string[],
): Promise<DailyPnlBreakdownSummaryCh> {
  if (!DAY_RE.test(dayUtc)) {
    throw new Error("Invalid day — expected YYYY-MM-DD.");
  }
  const since = new Date(`${dayUtc}T00:00:00.000Z`);
  const until = new Date(since.getTime() + DAY_MS);
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = {
    since: chDateTime(since),
    until: chDateTime(until),
    blacklist,
  };
  const cte = realUsersCte(hasBlacklist);
  const inDay = (col: string) =>
    `ifNull(${col} >= {since:DateTime64(6)} AND ${col} < {until:DateTime64(6)}, 0)`;

  const ledgerSql = `
    WITH ${cte}
    SELECT
      toString(sumIf(lt.amount, lt.type = 'deposit'))                                   AS deposits,
      toString(countIf(lt.type = 'deposit'))                                            AS deposit_count,
      toString(sumIf(lt.amount,
        lt.type = 'admin_balance_adjustment'
        AND lt.balance_after < lt.balance_before
        AND lt.description ILIKE 'Manual withdrawal:%'))                                AS manual_wd,
      toString(countIf(
        lt.type = 'admin_balance_adjustment'
        AND lt.balance_after < lt.balance_before
        AND lt.description ILIKE 'Manual withdrawal:%'))                                AS manual_wd_count,
      toString(sum(if(${STATS_EXCLUDED_CH}, toDecimal128(0, 2), lt.balance_after - lt.balance_before))) AS balance_change,
      toString(countIf(NOT (${STATS_EXCLUDED_CH})))                                     AS balance_count
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.created_at >= {since:DateTime64(6)}
      AND lt.created_at <  {until:DateTime64(6)}
      AND lt.user_id IN (SELECT id FROM real_users)`;

  const cardSql = `
    WITH ${cte}
    SELECT
      toString(sum(cwr.total_value_usd)) AS card_wd,
      toString(count())                  AS card_count
    FROM ${CH_DB}.public_card_withdrawal_requests AS cwr FINAL
    WHERE cwr._peerdb_is_deleted = 0
      AND cwr.status IN ('completed','shipped')
      AND ${inDay("coalesce(cwr.shipped_at, cwr.completed_at)")}
      AND cwr.user_id IN (SELECT id FROM real_users)`;

  const invSql = `
    WITH ${cte}
    SELECT
      toString(sumIf(ui.value_at_obtained, ${inDay("ui.obtained_at")}))                       AS obtained,
      toString(countIf(${inDay("ui.obtained_at")}))                                           AS obtained_count,
      toString(sumIf(ui.value_at_obtained, ${inDay("coalesce(ui.sold_at, ui.exchanged_at)")})) AS disposed,
      toString(countIf(${inDay("coalesce(ui.sold_at, ui.exchanged_at)")}))                     AS disposed_count
    FROM ${CH_DB}.public_user_inventory AS ui FINAL
    WHERE ui._peerdb_is_deleted = 0
      AND ui.user_id IN (SELECT id FROM real_users)
      AND ${nonCreatorOwnerCh("ui.user_id")}
      AND (${inDay("ui.obtained_at")} OR ${inDay("coalesce(ui.sold_at, ui.exchanged_at)")})`;

  const vchSql = `
    WITH ${cte}
    SELECT
      toString(sumIf(v.value, ${inDay("v.created_at")}))   AS issued,
      toString(countIf(${inDay("v.created_at")}))          AS issued_count,
      toString(sumIf(v.value, ${inDay("v.claimed_at")}))   AS claimed,
      toString(countIf(${inDay("v.claimed_at")}))          AS claimed_count
    FROM ${CH_DB}.public_vouchers AS v FINAL
    WHERE v._peerdb_is_deleted = 0
      AND v.user_id IN (SELECT id FROM real_users)
      AND (${inDay("v.created_at")} OR ${inDay("v.claimed_at")})`;

  const [ledgerRows, cardRows, invRows, vchRows] = await Promise.all([
    clickhouseRead.query<LedgerRow>({
      queryName: "dashboard.dailyPnlBreakdown.ledger",
      sql: ledgerSql,
      params,
    }),
    clickhouseRead.query<CardRow>({
      queryName: "dashboard.dailyPnlBreakdown.card",
      sql: cardSql,
      params,
    }),
    clickhouseRead.query<InvRow>({
      queryName: "dashboard.dailyPnlBreakdown.inventory",
      sql: invSql,
      params,
    }),
    clickhouseRead.query<VchRow>({
      queryName: "dashboard.dailyPnlBreakdown.voucher",
      sql: vchSql,
      params,
    }),
  ]);

  const lr = ledgerRows[0];
  const cr = cardRows[0];
  const ir = invRows[0];
  const vr = vchRows[0];

  const deposits = toNumber(lr?.deposits);
  const manualWd = toNumber(lr?.manual_wd);
  const balanceChange = toNumber(lr?.balance_change);
  const cardWd = toNumber(cr?.card_wd);
  const obtained = toNumber(ir?.obtained);
  const disposed = toNumber(ir?.disposed);
  const issued = toNumber(vr?.issued);
  const claimed = toNumber(vr?.claimed);

  const inventoryChange = obtained - disposed;
  const voucherChange = issued - claimed;
  const withdrawals = Math.abs(manualWd) + cardWd;
  const pnl =
    deposits -
    (Math.abs(manualWd) + cardWd) -
    balanceChange -
    inventoryChange -
    voucherChange;

  return {
    date: dayUtc,
    deposits,
    withdrawals,
    balanceChange,
    inventoryChange,
    voucherChange,
    pnl,
    depositCount: Number(lr?.deposit_count ?? 0),
    withdrawalCount:
      Number(lr?.manual_wd_count ?? 0) + Number(cr?.card_count ?? 0),
    balanceCount: Number(lr?.balance_count ?? 0),
    inventoryCount:
      Number(ir?.obtained_count ?? 0) + Number(ir?.disposed_count ?? 0),
    voucherCount: Number(vr?.issued_count ?? 0) + Number(vr?.claimed_count ?? 0),
  };
}
