import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { toNumber } from "@/lib/utils/decimal";

/**
 * Phase 2A — Lifetime realized P&L snapshot, read from the ClickHouse prod
 * game mirror (`packy_prod`, PeerDB CDC).
 *
 * Twin of the canonical Postgres definition `getRealizedPnlSnapshot`
 * (src/lib/queries/_realized-pnl.ts → realizedPnlSnapshotInner). Returns the
 * SAME shape ({@link RealizedPnlSnapshot}) so comparison mode can diff the two
 * paths field-for-field.
 *
 * ─── Canonical formula (House perspective, from pnl.ts) ──────────────
 *
 *   housePnl = deposits − withdrawals − onSiteBalance − inventory − vouchers
 *                                                              − unclaimedRakeback
 *
 * Component definitions (each scoped to real customers — see scope note):
 *   • deposits        = SUM(balances.total_deposited)
 *   • withdrawals     = SUM(balances.total_withdrawn)                       (legacy ledger leg)
 *                     + SUM(card_withdrawal_requests.total_value_usd)       (card/crypto leg)
 *                       WHERE status IN ('pending','processing','shipped','completed')
 *                       — the WITHDRAWAL_LIABILITY_STATUSES set: in-flight
 *                       withdrawals are a house liability, counted exactly
 *                       once (their inventory is excluded below via
 *                       withdrawal_locked_at IS NULL).
 *   • onSiteBalance   = SUM(available_balance) + SUM(locked_balance)
 *                       − official_stream_net − remove_locked_net           (carve-outs, see below)
 *   • inventory       = SUM(user_inventory.value_at_obtained)
 *                       WHERE sold_at IS NULL AND exchanged_at IS NULL
 *                         AND withdrawal_locked_at IS NULL
 *   • vouchers        = SUM(vouchers.value) WHERE claimed_at IS NULL
 *   • unclaimedRakeback = SUM(rakeback_claims.rakeback_amount_usd) WHERE claimed_at IS NULL
 *
 * Carve-outs replicated EXACTLY from the PG twin:
 *   • official_stream_net = SIGNED NET SUM(amount) of completed
 *     `admin_balance_adjustment` ledger rows whose
 *     metadata.adjustment_category = 'official_stream'. These credit REAL
 *     available_balance but are owner-designated FAKE balance, so the live
 *     balance term double-counts them — subtract the signed net (NET, not ABS,
 *     so a later clawback debit self-reverses).
 *   • remove_locked_net = SIGNED NET SUM(amount) of completed
 *     `admin_balance_adjustment` rows whose
 *     metadata.adjustment_category = 'remove_locked_balance'. locked_balance
 *     already dropped in the raw row, so subtract the signed ledger amount to
 *     keep onSiteBalance / P&L unchanged.
 *   (Both predicates are POSITIVE matches here — the snapshot sums them
 *    directly rather than negating — so the 3VL `IS NOT NULL` guard the PG
 *    helper carries is a no-op; ClickHouse `JSONExtractString` returns '' for
 *    a NULL/missing key, which never equals either category string.)
 *
 * ClickHouse correctness (PeerDB / SharedReplacingMergeTree mirrors):
 *   • Dedup latest row per id with FINAL on every public_* table.
 *   • Drop soft-deleted rows with `_peerdb_is_deleted = 0`.
 *   • Money stays Decimal end-to-end — toString(sum(...)) in SQL, parsed via
 *     toNumber() in TS — never Float / toFloat, so parity is exact to the cent.
 *   • The Postgres `jsonb` `metadata` column is mirrored as a ClickHouse
 *     String; `metadata->>'key'` maps to `JSONExtractString(metadata,'key')`.
 *
 * The blacklist is passed IN by the caller (resolved from the admin DB via
 * getExcludedUserIds) so this module never imports a Postgres client — it is a
 * pure ClickHouse read.
 */

export type RealizedPnlSnapshot = {
  pnl: number;
  totalDeposited: number;
  totalWithdrawn: number;
  userBalance: number;
  inventory: number;
  vouchers: number;
  unclaimedRakeback: number;
};

const CH_DB = "packy_prod";

/**
 * The fake-balance / locked-removal adjustment category keys carved out of
 * onSiteBalance. Inlined as literal strings (the canonical enum keys from
 * src/lib/balance-adjustment-categories.ts) rather than imported, so this pure
 * ClickHouse read stays free of the Prisma/browser coupling that module pulls
 * in. NEVER rename without a backfill — old ledger rows carry the old string.
 */
const OFFICIAL_STREAM_CATEGORY = "official_stream";
const REMOVE_LOCKED_BALANCE_CATEGORY = "remove_locked_balance";

/** WITHDRAWAL_LIABILITY_STATUSES (pnl.ts) — in-flight + done count as a liability. */
const WITHDRAWAL_LIABILITY_STATUSES = [
  "pending",
  "processing",
  "shipped",
  "completed",
] as const;

/**
 * Real-customer scope — ALIGNED to the PG twin `realizedPnlSnapshotInner`
 * (`role NOT IN ('admin','support')`, i.e. creators are KEPT). The PG twin's
 * own doc: "Creators are real users — their wagers/deposits/payouts count in
 * P&L like everyone else." This intentionally does NOT use the canonical
 * 3-role `getMetricsScope` (which drops creators); matching the PG twin is what
 * makes comparison-mode drift reflect engine/CDC-lag only. Canonicalizing the
 * served PnL to 3-role would change live numbers and is an owner decision (see
 * the mission escalation note), not a change to make here.
 */
function realUsersCte(hasBlacklist: boolean): string {
  return `real_users AS (
      SELECT id
      FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND role NOT IN ('admin','support')
        ${hasBlacklist ? "AND id NOT IN {blacklist:Array(String)}" : ""}
    )`;
}

type SnapshotRow = {
  deposited: string;
  balance_withdrawn: string;
  card_withdrawn: string;
  available_balance: string;
  locked_balance: string;
  inventory: string;
  vouchers: string;
  unclaimed_rakeback: string;
  official_stream_net: string;
  remove_locked_net: string;
};

export async function getRealizedPnlSnapshotFromClickHouse(
  blacklist: string[],
): Promise<RealizedPnlSnapshot> {
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = { blacklist };

  const wdStatusList = WITHDRAWAL_LIABILITY_STATUSES.map(
    (s) => `'${s}'`,
  ).join(",");

  // One round-trip per source table, summed independently, then combined in
  // TS — mirrors the PG twin's single multi-subquery SELECT (split here so each
  // FINAL scan stays a simple single-table aggregate). Money columns are summed
  // as Decimal and returned via toString → toNumber (never Float).
  const balancesSql = `
    WITH ${realUsersCte(hasBlacklist)}
    SELECT
      toString(sum(b.total_deposited))   AS deposited,
      toString(sum(b.total_withdrawn))   AS balance_withdrawn,
      toString(sum(b.available_balance)) AS available_balance,
      toString(sum(b.locked_balance))    AS locked_balance
    FROM ${CH_DB}.public_balances AS b FINAL
    WHERE b._peerdb_is_deleted = 0
      AND b.user_id IN (SELECT id FROM real_users)`;

  const cardWithdrawalsSql = `
    WITH ${realUsersCte(hasBlacklist)}
    SELECT toString(sum(cwr.total_value_usd)) AS card_withdrawn
    FROM ${CH_DB}.public_card_withdrawal_requests AS cwr FINAL
    WHERE cwr._peerdb_is_deleted = 0
      AND cwr.status IN (${wdStatusList})
      AND cwr.user_id IN (SELECT id FROM real_users)`;

  const inventorySql = `
    WITH ${realUsersCte(hasBlacklist)}
    SELECT toString(sum(ui.value_at_obtained)) AS inventory
    FROM ${CH_DB}.public_user_inventory AS ui FINAL
    WHERE ui._peerdb_is_deleted = 0
      AND ui.sold_at IS NULL
      AND ui.exchanged_at IS NULL
      AND ui.withdrawal_locked_at IS NULL
      AND ui.user_id IN (SELECT id FROM real_users)`;

  const vouchersSql = `
    WITH ${realUsersCte(hasBlacklist)}
    SELECT toString(sum(v.value)) AS vouchers
    FROM ${CH_DB}.public_vouchers AS v FINAL
    WHERE v._peerdb_is_deleted = 0
      AND v.claimed_at IS NULL
      AND v.user_id IN (SELECT id FROM real_users)`;

  const rakebackSql = `
    WITH ${realUsersCte(hasBlacklist)}
    SELECT toString(sum(rc.rakeback_amount_usd)) AS unclaimed_rakeback
    FROM ${CH_DB}.public_rakeback_claims AS rc FINAL
    WHERE rc._peerdb_is_deleted = 0
      AND rc.claimed_at IS NULL
      AND rc.user_id IN (SELECT id FROM real_users)`;

  // SIGNED NET (sum(amount), not ABS) so carve-outs self-reverse on clawback —
  // exactly as the PG twin does. Positive category match only (no negation), so
  // the 3VL IS NOT NULL guard the PG helper carries is unnecessary here.
  const adjustmentsSql = `
    WITH ${realUsersCte(hasBlacklist)}
    SELECT
      toString(sum(if(JSONExtractString(lt.metadata, 'adjustment_category') = '${OFFICIAL_STREAM_CATEGORY}', lt.amount, toDecimal128(0, 2))))        AS official_stream_net,
      toString(sum(if(JSONExtractString(lt.metadata, 'adjustment_category') = '${REMOVE_LOCKED_BALANCE_CATEGORY}', lt.amount, toDecimal128(0, 2)))) AS remove_locked_net
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.type = 'admin_balance_adjustment'
      AND lt.user_id IN (SELECT id FROM real_users)`;

  const [bal, card, inv, vch, rake, adj] = await Promise.all([
    clickhouseRead.query<{
      deposited: string;
      balance_withdrawn: string;
      available_balance: string;
      locked_balance: string;
    }>({
      queryName: "realizedPnl.snapshot.balances",
      sql: balancesSql,
      params,
    }),
    clickhouseRead.query<{ card_withdrawn: string }>({
      queryName: "realizedPnl.snapshot.cardWithdrawals",
      sql: cardWithdrawalsSql,
      params,
    }),
    clickhouseRead.query<{ inventory: string }>({
      queryName: "realizedPnl.snapshot.inventory",
      sql: inventorySql,
      params,
    }),
    clickhouseRead.query<{ vouchers: string }>({
      queryName: "realizedPnl.snapshot.vouchers",
      sql: vouchersSql,
      params,
    }),
    clickhouseRead.query<{ unclaimed_rakeback: string }>({
      queryName: "realizedPnl.snapshot.rakeback",
      sql: rakebackSql,
      params,
    }),
    clickhouseRead.query<{
      official_stream_net: string;
      remove_locked_net: string;
    }>({
      queryName: "realizedPnl.snapshot.adjustments",
      sql: adjustmentsSql,
      params,
    }),
  ]);

  const r: SnapshotRow = {
    deposited: bal[0]?.deposited ?? "0",
    balance_withdrawn: bal[0]?.balance_withdrawn ?? "0",
    card_withdrawn: card[0]?.card_withdrawn ?? "0",
    available_balance: bal[0]?.available_balance ?? "0",
    locked_balance: bal[0]?.locked_balance ?? "0",
    inventory: inv[0]?.inventory ?? "0",
    vouchers: vch[0]?.vouchers ?? "0",
    unclaimed_rakeback: rake[0]?.unclaimed_rakeback ?? "0",
    official_stream_net: adj[0]?.official_stream_net ?? "0",
    remove_locked_net: adj[0]?.remove_locked_net ?? "0",
  };

  const totalDeposited = toNumber(r.deposited);
  const balanceWithdrawn = toNumber(r.balance_withdrawn);
  const cardWithdrawn = toNumber(r.card_withdrawn);
  const totalWithdrawn = balanceWithdrawn + cardWithdrawn;
  const availableBalance = toNumber(r.available_balance);
  const lockedBalance = toNumber(r.locked_balance);
  const officialStreamNet = toNumber(r.official_stream_net);
  const removeLockedNet = toNumber(r.remove_locked_net);
  // Net out stats-excluded adjustments so they never enter the live-balance
  // P&L term (matches the PG twin exactly).
  const userBalance =
    availableBalance + lockedBalance - officialStreamNet - removeLockedNet;
  const inventory = toNumber(r.inventory);
  const vouchers = toNumber(r.vouchers);
  const unclaimedRakeback = toNumber(r.unclaimed_rakeback);

  // Canonical 5-term house formula, then subtract the global-only
  // unclaimed-rakeback liability — inlined here (instead of importing
  // computeHousePnl) to keep this a dependency-free ClickHouse read.
  // computeHousePnl(c) = c.deposits − c.withdrawals − c.onSiteBalance
  //                      − c.inventoryValue − c.unclaimedVouchers.
  const pnl =
    totalDeposited -
    totalWithdrawn -
    userBalance -
    inventory -
    vouchers -
    unclaimedRakeback;

  return {
    pnl,
    totalDeposited,
    totalWithdrawn,
    userBalance,
    inventory,
    vouchers,
    unclaimedRakeback,
  };
}
