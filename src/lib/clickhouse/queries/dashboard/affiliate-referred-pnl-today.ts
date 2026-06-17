import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { CH_DB, chDateTime, toNumber, nonCreatorOwnerCh } from "../_shared";

/**
 * Phase 2B — Dashboard "affiliate-referred players" house P&L (today), read
 * from the ClickHouse prod game mirror (`packy_prod`, PeerDB CDC).
 *
 * Twin of the canonical Postgres `getAffiliateReferredPnlToday`
 * (src/lib/queries/dashboard-affiliate-referred-pnl-today.ts), which calls
 * `calculateWindowedPnl({ since, excludeUserIds, populationScopeSql:
 * AFFILIATE_REFERRED_POPULATION_SCOPE_SQL })`. It is the SAME five-term
 * windowed-delta P&L as the dashboard "P&L Today" twin (windowed-pnl.ts),
 * narrowed to a sub-population:
 *
 *   pnl = Δdeposits − Δwithdrawals − Δbalance − Δinventory − Δvouchers
 *
 * over `[since, now)` (today 00:00 UTC, passed in).
 *
 * ─── Scope (mirrors the PG twin EXACTLY) ─────────────────────────────
 *
 * The global P&L scope (`role NOT IN ('admin','support')` + the excluded-users
 * blacklist — creators KEPT, see windowed-pnl.ts / ESC-1/ESC-2) FURTHER
 * narrowed to "affiliate-referred players": real customers whose `referred_by`
 * points to a `role = 'creator'` user. The PG fragment is
 * `u.referred_by IS NOT NULL AND EXISTS (creator referrer)`; mirrored here as
 * `ifNull(referred_by IN (creator ids), 0) = 1` (a NULL/empty referred_by maps
 * to the not-a-member branch — §5 NULL-in-IN guard — exactly like PG's EXISTS).
 *
 * ClickHouse correctness: FINAL + `_peerdb_is_deleted = 0`; money stays Decimal
 * (toString(sum(...)) → toNumber, never Float); `if()` zero-branches use
 * `toDecimal128(0, 2)`; metadata via JSONExtractString. The 5-term math is
 * byte-identical to windowed-pnl.ts (composed in TS from Decimal strings) — the
 * ONLY difference is the population predicate in the real_users CTE.
 */

export type AffiliateReferredPnlTodayCh = {
  deposits: number;
  withdrawals: number;
  balanceChange: number;
  inventoryChange: number;
  voucherChange: number;
  pnl: number;
};

const STATS_EXCLUDED_CATEGORIES = ["official_stream", "remove_locked_balance"] as const;
const STATS_EXCLUDED_SQL = `(${STATS_EXCLUDED_CATEGORIES.map((k) => `'${k}'`).join(",")})`;

/**
 * Real-customer scope (2-role, creators KEPT) + optional blacklist, FURTHER
 * narrowed to affiliate-referred players (referred_by → a creator account).
 */
function referredUsersCte(hasBlacklist: boolean): string {
  return `real_users AS (
      SELECT id
      FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND role NOT IN ('admin','support')
        ${hasBlacklist ? "AND id NOT IN {blacklist:Array(String)}" : ""}
        AND ifNull(referred_by IN (
          SELECT id FROM ${CH_DB}.public_user FINAL
          WHERE _peerdb_is_deleted = 0 AND role = 'creator'
        ), 0) = 1
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

export async function getAffiliateReferredPnlTodayFromClickHouse(
  since: Date,
  blacklist: string[],
): Promise<AffiliateReferredPnlTodayCh> {
  const cutoff = chDateTime(since);
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = { cutoff, blacklist };

  const statsExcluded = `lt.type = 'admin_balance_adjustment' AND JSONExtractString(lt.metadata, 'adjustment_category') IN ${STATS_EXCLUDED_SQL}`;
  const liveInventoryIds = `(SELECT toString(ui2.id) FROM ${CH_DB}.public_user_inventory AS ui2 FINAL WHERE ui2._peerdb_is_deleted = 0)`;
  const liveVoucherIds = `(SELECT toString(v2.id) FROM ${CH_DB}.public_vouchers AS v2 FINAL WHERE v2._peerdb_is_deleted = 0)`;

  const ledgerSql = `
    WITH ${referredUsersCte(hasBlacklist)}
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
    WITH ${referredUsersCte(hasBlacklist)}
    SELECT toString(sum(cwr.total_value_usd)) AS card_wd
    FROM ${CH_DB}.public_card_withdrawal_requests AS cwr FINAL
    WHERE cwr._peerdb_is_deleted = 0
      AND cwr.status IN ('completed','shipped')
      AND coalesce(cwr.shipped_at, cwr.completed_at) >= {cutoff:DateTime64(6)}
      AND cwr.user_id IN (SELECT id FROM real_users)`;

  const invSql = `
    WITH ${referredUsersCte(hasBlacklist)}
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
    WITH ${referredUsersCte(hasBlacklist)}
    SELECT
      toString(sum(if(v.created_at >= {cutoff:DateTime64(6)}, v.value, toDecimal128(0, 2)))) AS issued,
      toString(sum(if(ifNull(v.claimed_at >= {cutoff:DateTime64(6)}, 0) = 1, v.value, toDecimal128(0, 2)))) AS claimed_ui
    FROM ${CH_DB}.public_vouchers AS v FINAL
    WHERE v._peerdb_is_deleted = 0
      AND v.user_id IN (SELECT id FROM real_users)`;

  const [ledger, card, inv, vch] = await Promise.all([
    clickhouseRead.query<LedgerRow>({ queryName: "dashboard.affiliateReferredPnl.ledger", sql: ledgerSql, params }),
    clickhouseRead.query<CardRow>({ queryName: "dashboard.affiliateReferredPnl.card", sql: cardSql, params }),
    clickhouseRead.query<InvRow>({ queryName: "dashboard.affiliateReferredPnl.inventory", sql: invSql, params }),
    clickhouseRead.query<VchRow>({ queryName: "dashboard.affiliateReferredPnl.vouchers", sql: vchSql, params }),
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
