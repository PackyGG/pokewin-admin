import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { CH_DB, chDateTime, toNumber, nonCreatorOwnerCh } from "../_shared";

/**
 * Phase 2B — Rolling-window house P&L, read from the ClickHouse prod game
 * mirror (`packy_prod`, PeerDB CDC).
 *
 * Twin of the canonical Postgres `calculateWindowedPnl` (global path) in
 * `src/lib/queries/pnl.ts`. Returns the SAME {@link DashboardWindowedPnl} shape
 * so comparison mode can diff field-for-field. Shared by the dashboard
 * "P&L Today" (`getTodayPnl`) and "Avg P&L 7d" (`getAvgPnl7d`) surfaces, which
 * both call `calculateWindowedPnl({ since, excludeUserIds })` with a single
 * window.
 *
 * ─── Canonical windowed-delta formula (House perspective) ────────────
 *
 *   pnl = Δdeposits − Δwithdrawals − Δbalance − Δinventory − Δvouchers
 *
 * over `[since, now)`, where (each scoped to real customers — see scope note):
 *   • deposits      = Σ amount WHERE type='deposit', created_at >= since
 *   • manualWd      = Σ amount WHERE type='admin_balance_adjustment'
 *                       AND balance_after < balance_before
 *                       AND description ILIKE 'Manual withdrawal:%'
 *                       (carries its stored sign)
 *   • cardWd        = Σ card_withdrawal_requests.total_value_usd
 *                       WHERE status IN ('completed','shipped')
 *                       AND COALESCE(shipped_at, completed_at) >= since
 *   • balanceChange = Σ CASE WHEN stats-excluded adjustment THEN 0
 *                            ELSE (balance_after − balance_before) END
 *   • inventory Δ   = obtained − disposed, where
 *       obtained = Σ value_at_obtained WHERE obtained_at >= since
 *       disposed = Σ value_at_obtained WHERE sold_at>=since OR exchanged_at>=since
 *                  + admin inventory-removal disposals (ledger
 *                    admin_balance_adjustment, metadata.kind='inventory_removal',
 *                    whose inventory_item_id no longer exists)
 *   • voucher Δ     = issued − claimed, where
 *       issued  = Σ value WHERE created_at >= since
 *       claimed = Σ value WHERE claimed_at >= since
 *                 + admin voucher-removal disposals (metadata.kind='voucher_removal',
 *                   whose voucher_id no longer exists)
 *
 *   withdrawals (reported) = |manualWd| + cardWd
 *   pnl = deposits − (manualWd + cardWd) − balanceChange − inventoryΔ − voucherΔ
 *
 * The arithmetic is composed in TS from Decimal string sums, byte-identical to
 * the PG twin (which also composes the final numbers in JS).
 *
 * ─── Scope (mirrors the PG twin EXACTLY — 2-role, creators KEPT) ──────
 *
 * `role NOT IN ('admin','support')` + the excluded-users blacklist. The whole
 * P&L family deliberately KEEPS creators as real users (owner decision, see
 * CLICKHOUSE_CQRS_ESCALATIONS.md ESC-1/ESC-2). This intentionally does NOT use
 * the canonical 3-role `getMetricsScope` / `customerScopeCte` (which drops
 * creators); matching the PG twin is what makes comparison drift reflect
 * engine/CDC-lag only.
 *
 * ClickHouse correctness (PeerDB / SharedReplacingMergeTree mirrors):
 *   • Dedup latest row per id with FINAL on every public_* table.
 *   • Drop soft-deleted rows with `_peerdb_is_deleted = 0`.
 *   • Money stays Decimal end-to-end — toString(sum(...)) in SQL, toNumber() in
 *     TS — never Float — so parity is exact to the cent. `if()` zero-branches
 *     use `toDecimal128(0, 2)` to keep the cents (a bare `0` truncates scale).
 *   • The Postgres `jsonb` metadata column is mirrored as a ClickHouse String;
 *     `metadata->>'key'` maps to `JSONExtractString(metadata,'key')`.
 *
 * The blacklist is passed IN by the caller (resolved from the admin DB via
 * getExcludedUserIds) so this module never imports a Postgres client.
 */

type DashboardWindowedPnl = {
  deposits: number;
  withdrawals: number;
  balanceChange: number;
  inventoryChange: number;
  voucherChange: number;
  pnl: number;
};

/** Stats-excluded adjustment categories netted OUT of balanceChange. Inlined
 *  literal keys (canonical source: STATS_EXCLUDED_ADJUSTMENT_CATEGORY_KEYS in
 *  balance-adjustment-categories.ts) so this pure CH read never pulls Prisma. */
const STATS_EXCLUDED_CATEGORIES = ["official_stream", "remove_locked_balance"] as const;
const STATS_EXCLUDED_SQL = `(${STATS_EXCLUDED_CATEGORIES.map((k) => `'${k}'`).join(",")})`;

/** Real-customer scope — 2-role (creators KEPT) + optional blacklist. */
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
  manual_wd: string;
  balance_change: string;
  admin_inv_removal: string;
  admin_vch_removal: string;
};
type CardRow = { card_wd: string };
type InvRow = { obtained: string; disposed_ui: string };
type VchRow = { issued: string; claimed_ui: string };

export async function getWindowedPnlFromClickHouse(
  since: Date,
  blacklist: string[],
): Promise<DashboardWindowedPnl> {
  const cutoff = chDateTime(since);
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = { cutoff, blacklist };

  // statsExcluded predicate (mirrors statsExcludedAdjustmentSqlPredicate). The
  // PG `IS NOT NULL` 3VL guard is a no-op here: JSONExtractString returns ''
  // for a missing/null key, which never matches the category list, so an
  // uncategorized adjustment falls to the ELSE (counted) branch — same as PG.
  const statsExcluded = `lt.type = 'admin_balance_adjustment' AND JSONExtractString(lt.metadata, 'adjustment_category') IN ${STATS_EXCLUDED_SQL}`;

  // Anti-membership for admin inventory/voucher removals: the referenced item
  // id no longer exists (mirrors PG `NOT EXISTS`). JSONExtractString never
  // returns NULL, so the §5 NULL-in-IN footgun does not apply here.
  const liveInventoryIds = `(SELECT toString(ui2.id) FROM ${CH_DB}.public_user_inventory AS ui2 FINAL WHERE ui2._peerdb_is_deleted = 0)`;
  const liveVoucherIds = `(SELECT toString(v2.id) FROM ${CH_DB}.public_vouchers AS v2 FINAL WHERE v2._peerdb_is_deleted = 0)`;

  const ledgerSql = `
    WITH ${realUsersCte(hasBlacklist)}
    SELECT
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
        AND ${nonCreatorOwnerCh("lt.user_id")}
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
      AND lt.user_id IN (SELECT id FROM real_users)`;

  const cardSql = `
    WITH ${realUsersCte(hasBlacklist)}
    SELECT toString(sum(cwr.total_value_usd)) AS card_wd
    FROM ${CH_DB}.public_card_withdrawal_requests AS cwr FINAL
    WHERE cwr._peerdb_is_deleted = 0
      AND cwr.status IN ('completed','shipped')
      AND coalesce(cwr.shipped_at, cwr.completed_at) >= {cutoff:DateTime64(6)}
      AND cwr.user_id IN (SELECT id FROM real_users)`;

  const invSql = `
    WITH ${realUsersCte(hasBlacklist)}
    SELECT
      toString(sum(if(ui.obtained_at >= {cutoff:DateTime64(6)}, ui.value_at_obtained, toDecimal128(0, 2)))) AS obtained,
      toString(sum(if(
        ifNull(ui.sold_at >= {cutoff:DateTime64(6)}, 0) = 1
        OR ifNull(ui.exchanged_at >= {cutoff:DateTime64(6)}, 0) = 1,
        ui.value_at_obtained, toDecimal128(0, 2)))) AS disposed_ui
    FROM ${CH_DB}.public_user_inventory AS ui FINAL
    WHERE ui._peerdb_is_deleted = 0
      AND ui.user_id IN (SELECT id FROM real_users)
      AND ${nonCreatorOwnerCh("ui.user_id")}`;

  const vchSql = `
    WITH ${realUsersCte(hasBlacklist)}
    SELECT
      toString(sum(if(v.created_at >= {cutoff:DateTime64(6)}, v.value, toDecimal128(0, 2)))) AS issued,
      toString(sum(if(ifNull(v.claimed_at >= {cutoff:DateTime64(6)}, 0) = 1, v.value, toDecimal128(0, 2)))) AS claimed_ui
    FROM ${CH_DB}.public_vouchers AS v FINAL
    WHERE v._peerdb_is_deleted = 0
      AND v.user_id IN (SELECT id FROM real_users)`;

  const [ledger, card, inv, vch] = await Promise.all([
    clickhouseRead.query<LedgerRow>({ queryName: "dashboard.windowedPnl.ledger", sql: ledgerSql, params }),
    clickhouseRead.query<CardRow>({ queryName: "dashboard.windowedPnl.card", sql: cardSql, params }),
    clickhouseRead.query<InvRow>({ queryName: "dashboard.windowedPnl.inventory", sql: invSql, params }),
    clickhouseRead.query<VchRow>({ queryName: "dashboard.windowedPnl.vouchers", sql: vchSql, params }),
  ]);

  const l = ledger[0];
  const deposits = toNumber(l?.deposits);
  const manualWd = toNumber(l?.manual_wd);
  const balanceChange = toNumber(l?.balance_change);
  const adminInvRemoval = toNumber(l?.admin_inv_removal);
  const adminVchRemoval = toNumber(l?.admin_vch_removal);
  const cardWd = toNumber(card[0]?.card_wd);

  const obtained = toNumber(inv[0]?.obtained);
  const disposed = toNumber(inv[0]?.disposed_ui) + adminInvRemoval;
  const inventoryChange = obtained - disposed;

  const issued = toNumber(vch[0]?.issued);
  const claimed = toNumber(vch[0]?.claimed_ui) + adminVchRemoval;
  const voucherChange = issued - claimed;

  const withdrawals = Math.abs(manualWd) + cardWd;
  const pnl =
    deposits - (manualWd + cardWd) - balanceChange - inventoryChange - voucherChange;

  return { deposits, withdrawals, balanceChange, inventoryChange, voucherChange, pnl };
}
