import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { CH_DB, chDateTime, toNumber } from "../_shared";

/**
 * Phase 2B — Daily house P&L for the last 30 days, read from the ClickHouse
 * prod game mirror (`packy_prod`, PeerDB CDC).
 *
 * Twin of the canonical Postgres `getDailyPnl` → `computeDailyPnl`
 * (src/lib/queries/pnl.ts). Returns the SAME {@link DailyPnlPoint}[] shape (one
 * point per UTC day with activity) so comparison mode can diff per-day.
 *
 * Per-day breakdown of the SAME windowed-delta formula `calculateWindowedPnl`
 * uses (see windowed-pnl.ts), bucketed by each component's own event date:
 *   • ledger legs (deposits / manualWd / balanceChange / admin removals) by
 *     toDate(created_at)
 *   • card withdrawals by toDate(COALESCE(shipped_at, completed_at))
 *   • inventory obtained by toDate(obtained_at); disposed by
 *     toDate(COALESCE(sold_at, exchanged_at))
 *   • vouchers issued by toDate(created_at); claimed by toDate(claimed_at)
 * then combined per day:
 *   pnl = deposits − (manualWd + cardWd) − balanceΔ − inventoryΔ − voucherΔ
 *
 * Window: `[now − 30d, now)`. The PG twin hardcodes `NOW() - INTERVAL '30 days'`
 * (server clock); this twin takes the cutoff from the caller's `now` so a
 * parity harness can feed BOTH engines the same instant. Scope mirrors the PG
 * twin EXACTLY — 2-role (`role NOT IN ('admin','support')`, creators KEPT) +
 * blacklist (see windowed-pnl.ts / ESC-1/ESC-2).
 *
 * ClickHouse correctness: FINAL + `_peerdb_is_deleted = 0`; money stays Decimal
 * (toString(sum(...)) → toNumber, never Float); `if()` zero-branches use
 * `toDecimal128(0, 2)`; toDate truncates to the UTC calendar day (mirrors PG
 * `DATE(created_at)` under TZ=UTC); metadata via JSONExtractString.
 */

export type DailyPnlPoint = {
  date: string;
  pnl: number;
  deposits: number;
  withdrawals: number;
  balanceChange: number;
  inventoryChange: number;
  voucherChange: number;
};

const ROLLING_30D_MS = 30 * 24 * 60 * 60 * 1000;

const STATS_EXCLUDED_CATEGORIES = ["official_stream", "remove_locked_balance"] as const;
const STATS_EXCLUDED_SQL = `(${STATS_EXCLUDED_CATEGORIES.map((k) => `'${k}'`).join(",")})`;

function realUsersCte(hasBlacklist: boolean): string {
  return `real_users AS (
      SELECT id
      FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND role NOT IN ('admin','support')
        ${hasBlacklist ? "AND id NOT IN {blacklist:Array(String)}" : ""}
    )`;
}

type LedgerDayRow = {
  d: string;
  deposits: string;
  manual_wd: string;
  balance_change: string;
  admin_inv_removal: string;
  admin_vch_removal: string;
};
type CardDayRow = { d: string; card_wd: string };
type ObtainedDayRow = { d: string; obtained: string };
type DisposedDayRow = { d: string; disposed_ui: string };
type IssuedDayRow = { d: string; issued: string };
type ClaimedDayRow = { d: string; claimed_ui: string };

type Acc = {
  deposits: number;
  manualWd: number;
  cardWd: number;
  balanceChange: number;
  obtained: number;
  disposed: number;
  issued: number;
  claimed: number;
};

export async function getDailyPnlFromClickHouse(
  blacklist: string[],
  now: Date = new Date(),
): Promise<DailyPnlPoint[]> {
  const cutoff = chDateTime(new Date(now.getTime() - ROLLING_30D_MS));
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = { cutoff, blacklist };

  const statsExcluded = `lt.type = 'admin_balance_adjustment' AND JSONExtractString(lt.metadata, 'adjustment_category') IN ${STATS_EXCLUDED_SQL}`;
  const liveInventoryIds = `(SELECT toString(ui2.id) FROM ${CH_DB}.public_user_inventory AS ui2 FINAL WHERE ui2._peerdb_is_deleted = 0)`;
  const liveVoucherIds = `(SELECT toString(v2.id) FROM ${CH_DB}.public_vouchers AS v2 FINAL WHERE v2._peerdb_is_deleted = 0)`;

  const cte = realUsersCte(hasBlacklist);

  const ledgerSql = `
    WITH ${cte}
    SELECT
      toString(toDate(lt.created_at)) AS d,
      toString(sum(if(lt.type = 'deposit', lt.amount, toDecimal128(0, 2)))) AS deposits,
      toString(sum(if(
        lt.type = 'admin_balance_adjustment'
        AND lt.balance_after < lt.balance_before
        AND lt.description ILIKE 'Manual withdrawal:%',
        lt.amount, toDecimal128(0, 2)))) AS manual_wd,
      toString(sum(if(${statsExcluded}, toDecimal128(0, 2), lt.balance_after - lt.balance_before))) AS balance_change,
      toString(sum(if(
        lt.type = 'admin_balance_adjustment'
        AND JSONExtractString(lt.metadata, 'kind') = 'inventory_removal'
        AND JSONExtractString(lt.metadata, 'inventory_item_id') NOT IN ${liveInventoryIds},
        abs(lt.amount), toDecimal128(0, 2)))) AS admin_inv_removal,
      toString(sum(if(
        lt.type = 'admin_balance_adjustment'
        AND JSONExtractString(lt.metadata, 'kind') = 'voucher_removal'
        AND JSONExtractString(lt.metadata, 'voucher_id') NOT IN ${liveVoucherIds},
        abs(lt.amount), toDecimal128(0, 2)))) AS admin_vch_removal
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.created_at >= {cutoff:DateTime64(6)}
      AND lt.user_id IN (SELECT id FROM real_users)
    GROUP BY toDate(lt.created_at)`;

  const cardSql = `
    WITH ${cte}
    SELECT
      toString(toDate(coalesce(cwr.shipped_at, cwr.completed_at))) AS d,
      toString(sum(cwr.total_value_usd)) AS card_wd
    FROM ${CH_DB}.public_card_withdrawal_requests AS cwr FINAL
    WHERE cwr._peerdb_is_deleted = 0
      AND cwr.status IN ('completed','shipped')
      AND coalesce(cwr.shipped_at, cwr.completed_at) >= {cutoff:DateTime64(6)}
      AND cwr.user_id IN (SELECT id FROM real_users)
    GROUP BY toDate(coalesce(cwr.shipped_at, cwr.completed_at))`;

  const obtainedSql = `
    WITH ${cte}
    SELECT
      toString(toDate(ui.obtained_at)) AS d,
      toString(sum(ui.value_at_obtained)) AS obtained
    FROM ${CH_DB}.public_user_inventory AS ui FINAL
    WHERE ui._peerdb_is_deleted = 0
      AND ui.obtained_at >= {cutoff:DateTime64(6)}
      AND ui.user_id IN (SELECT id FROM real_users)
    GROUP BY toDate(ui.obtained_at)`;

  const disposedSql = `
    WITH ${cte}
    SELECT
      toString(toDate(coalesce(ui.sold_at, ui.exchanged_at))) AS d,
      toString(sum(ui.value_at_obtained)) AS disposed_ui
    FROM ${CH_DB}.public_user_inventory AS ui FINAL
    WHERE ui._peerdb_is_deleted = 0
      AND (ifNull(ui.sold_at >= {cutoff:DateTime64(6)}, 0) = 1
        OR ifNull(ui.exchanged_at >= {cutoff:DateTime64(6)}, 0) = 1)
      AND ui.user_id IN (SELECT id FROM real_users)
    GROUP BY toDate(coalesce(ui.sold_at, ui.exchanged_at))`;

  const issuedSql = `
    WITH ${cte}
    SELECT
      toString(toDate(v.created_at)) AS d,
      toString(sum(v.value)) AS issued
    FROM ${CH_DB}.public_vouchers AS v FINAL
    WHERE v._peerdb_is_deleted = 0
      AND v.created_at >= {cutoff:DateTime64(6)}
      AND v.user_id IN (SELECT id FROM real_users)
    GROUP BY toDate(v.created_at)`;

  const claimedSql = `
    WITH ${cte}
    SELECT
      toString(toDate(v.claimed_at)) AS d,
      toString(sum(v.value)) AS claimed_ui
    FROM ${CH_DB}.public_vouchers AS v FINAL
    WHERE v._peerdb_is_deleted = 0
      AND ifNull(v.claimed_at >= {cutoff:DateTime64(6)}, 0) = 1
      AND v.user_id IN (SELECT id FROM real_users)
    GROUP BY toDate(v.claimed_at)`;

  const [ledger, card, obtained, disposed, issued, claimed] = await Promise.all([
    clickhouseRead.query<LedgerDayRow>({ queryName: "dashboard.dailyPnl.ledger", sql: ledgerSql, params }),
    clickhouseRead.query<CardDayRow>({ queryName: "dashboard.dailyPnl.card", sql: cardSql, params }),
    clickhouseRead.query<ObtainedDayRow>({ queryName: "dashboard.dailyPnl.obtained", sql: obtainedSql, params }),
    clickhouseRead.query<DisposedDayRow>({ queryName: "dashboard.dailyPnl.disposed", sql: disposedSql, params }),
    clickhouseRead.query<IssuedDayRow>({ queryName: "dashboard.dailyPnl.issued", sql: issuedSql, params }),
    clickhouseRead.query<ClaimedDayRow>({ queryName: "dashboard.dailyPnl.claimed", sql: claimedSql, params }),
  ]);

  const byDay = new Map<string, Acc>();
  const dayKey = (d: string) => String(d).slice(0, 10);
  const acc = (k: string): Acc => {
    let a = byDay.get(k);
    if (!a) {
      a = {
        deposits: 0,
        manualWd: 0,
        cardWd: 0,
        balanceChange: 0,
        obtained: 0,
        disposed: 0,
        issued: 0,
        claimed: 0,
      };
      byDay.set(k, a);
    }
    return a;
  };

  for (const r of ledger) {
    const a = acc(dayKey(r.d));
    a.deposits += toNumber(r.deposits);
    a.manualWd += toNumber(r.manual_wd);
    a.balanceChange += toNumber(r.balance_change);
    // Admin inventory/voucher removals fold into the disposed/claimed legs,
    // bucketed by the ledger row's created_at day (mirrors the PG UNION).
    a.disposed += toNumber(r.admin_inv_removal);
    a.claimed += toNumber(r.admin_vch_removal);
  }
  for (const r of card) acc(dayKey(r.d)).cardWd += toNumber(r.card_wd);
  for (const r of obtained) acc(dayKey(r.d)).obtained += toNumber(r.obtained);
  for (const r of disposed) acc(dayKey(r.d)).disposed += toNumber(r.disposed_ui);
  for (const r of issued) acc(dayKey(r.d)).issued += toNumber(r.issued);
  for (const r of claimed) acc(dayKey(r.d)).claimed += toNumber(r.claimed_ui);

  return [...byDay.entries()]
    .map(([date, a]) => {
      const inventoryChange = a.obtained - a.disposed;
      const voucherChange = a.issued - a.claimed;
      return {
        date,
        pnl:
          a.deposits -
          (a.manualWd + a.cardWd) -
          a.balanceChange -
          inventoryChange -
          voucherChange,
        deposits: a.deposits,
        withdrawals: Math.abs(a.manualWd) + a.cardWd,
        balanceChange: a.balanceChange,
        inventoryChange,
        voucherChange,
      };
    })
    .sort((x, y) => x.date.localeCompare(y.date));
}
