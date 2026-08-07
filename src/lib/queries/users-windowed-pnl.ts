import { queryMainRows } from "@/lib/drizzle-query";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { statsExcludedAdjustmentSqlPredicate } from "@/lib/balance-adjustment-categories";
import {
  fiatRefundAttributionTimestampSql,
  fiatRefundCreditUsdSql,
} from "./fiat-refund-credits";
import { nonCreatorOwnerSql } from "./_creator-pnl-exclusion";
import type { WindowedPnl } from "./pnl";

/**
 * Multi-window per-user windowed P&L — single round-trip per source
 * table, all windows packed into one SELECT via `SUM(CASE WHEN >= $n
 * THEN <metric> ELSE 0 END)` per window per metric.
 *
 * Background: `calculateWindowedPnl` issues 4 raw queries per call
 * (ledger / card_withdrawal_requests / user_inventory / vouchers).
 * Callers like `getUserPnlBreakdown` need a rolling P&L ladder across 4
 * windows — 4 × 4 = 16 round-trips per page render without packing.
 *
 * Packs the windows with the same CASE-WHEN-per-window pattern used by
 * the global P&L queries, scoped to one user.
 *
 * Each returned WindowedPnl is byte-for-byte equal to what
 * `calculateWindowedPnl({ userId, since: window.since })` would return
 * for the same `since`, with the identical formula:
 *
 *   pnl = deposits − withdrawals − balanceΔ − inventoryΔ − voucherΔ
 *
 * The outer WHERE per table filters to the DEEPEST window's cutoff
 * (smallest `since` = earliest cutoff), so each CASE branch can simply
 * compare `created_at >= $N` for its window. Rows older than the
 * deepest window contribute zero to every CASE branch and so don't
 * affect the result.
 *
 * Result is keyed by the `key` the caller passed in (e.g. "12h",
 * "24h", "3d", "7d"). Missing keys never occur — every input window
 * gets an entry, zeroed if no rows match.
 */
export async function getUserWindowedPnlMulti(
  userId: string,
  windows: { key: string; since: Date }[],
): Promise<Record<string, WindowedPnl>> {
  const result: Record<string, WindowedPnl> = {};
  if (windows.length === 0) return result;

  return withTiming("pnl.userWindowedMulti", async () => {

    // Deepest cutoff (earliest `since`) drives the outer WHERE per
    // table. Each per-window CASE compares against its own `since`
    // bind. Rows older than the deepest cutoff are out entirely.
    const deepest = windows.reduce(
      (acc, w) => (w.since < acc ? w.since : acc),
      windows[0].since,
    );

    // Window param indexes:
    //   $1 = userId
    //   $2 = deepest cutoff (used for outer WHERE)
    //   $3..$3+N-1 = per-window cutoffs in input order
    // The deepest is bound separately from the per-window cutoffs so
    // every per-window CASE has a stable index regardless of which
    // window happens to be the deepest one.
    const wParam = (i: number) => `$${3 + i}`;
    const params: unknown[] = [userId, deepest, ...windows.map((w) => w.since)];

    // Per-window CASE fragments — built once and reused inside each
    // metric expression.
    const ledgerDepositCase = windows
      .map(
        (_, i) =>
          `COALESCE(SUM(CASE WHEN lt.created_at >= ${wParam(i)} AND lt.type::text = 'deposit' THEN lt.amount::numeric ELSE 0 END), 0)::text AS deposits_${i}`,
      )
      .join(", ");
    const ledgerManualWdCase = windows
      .map(
        (_, i) =>
          `COALESCE(SUM(CASE WHEN lt.created_at >= ${wParam(i)} AND lt.type::text = 'admin_balance_adjustment' AND lt.description ILIKE 'Manual withdrawal:%' THEN COALESCE(NULLIF(lt.metadata->>'withdrawal_amount_usd', '')::numeric, ABS(lt.amount::numeric)) ELSE 0 END), 0)::text AS manual_wd_${i}`,
      )
      .join(", ");
    const fiatRefundCase = windows
      .map(
        (_, i) =>
          `COALESCE(SUM(CASE WHEN ${fiatRefundAttributionTimestampSql("i")} >= ${wParam(i)} THEN ${fiatRefundCreditUsdSql("i")} ELSE 0 END), 0)::text AS refunds_${i}`,
      )
      .join(", ");
    // Stats-excluded adjustments (official_stream + remove_locked_balance)
    // must NOT enter the balance-delta term — mirrors calculateWindowedPnl.
    const statsExcluded = statsExcludedAdjustmentSqlPredicate({
      typeColumn: "lt.type",
      metadataColumn: "lt.metadata",
    });
    const ledgerBalanceChangeCase = windows
      .map(
        (_, i) =>
          `COALESCE(SUM(CASE WHEN lt.created_at >= ${wParam(i)} AND NOT (${statsExcluded}) THEN (lt.balance_after - lt.balance_before)::numeric ELSE 0 END), 0)::text AS balance_change_${i}`,
      )
      .join(", ");
    const adminInvDisposedCase = windows
      .map(
        (_, i) =>
          `COALESCE(SUM(CASE WHEN lt.created_at >= ${wParam(i)} THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS admin_inv_disposed_${i}`,
      )
      .join(", ");
    const adminVchClaimedCase = windows
      .map(
        (_, i) =>
          `COALESCE(SUM(CASE WHEN lt.created_at >= ${wParam(i)} THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS admin_vch_claimed_${i}`,
      )
      .join(", ");

    const cardWdCase = windows
      .map(
        (_, i) =>
          `COALESCE(SUM(CASE WHEN COALESCE(cwr.shipped_at, cwr.completed_at) >= ${wParam(i)} THEN cwr.total_value_usd::numeric ELSE 0 END), 0)::text AS card_wd_${i}`,
      )
      .join(", ");

    const invObtainedCase = windows
      .map(
        (_, i) =>
          `COALESCE(SUM(CASE WHEN ui.obtained_at >= ${wParam(i)} THEN ui.value_at_obtained::numeric ELSE 0 END), 0)::text AS obtained_${i}`,
      )
      .join(", ");
    const invDisposedCase = windows
      .map(
        (_, i) =>
          `COALESCE(SUM(CASE WHEN (ui.sold_at >= ${wParam(i)} OR ui.exchanged_at >= ${wParam(i)}) THEN ui.value_at_obtained::numeric ELSE 0 END), 0)::text AS disposed_${i}`,
      )
      .join(", ");

    const vchIssuedCase = windows
      .map(
        (_, i) =>
          `COALESCE(SUM(CASE WHEN v.created_at >= ${wParam(i)} THEN v.value::numeric ELSE 0 END), 0)::text AS issued_${i}`,
      )
      .join(", ");
    const vchClaimedCase = windows
      .map(
        (_, i) =>
          `COALESCE(SUM(CASE WHEN v.claimed_at >= ${wParam(i)} THEN v.value::numeric ELSE 0 END), 0)::text AS claimed_${i}`,
      )
      .join(", ");

    type LedgerRow = Record<string, string>;
    type CardRow = Record<string, string>;
    type InvRow = Record<string, string>;
    type VchRow = Record<string, string>;

    const [ledger, card, inv, vch, adminInvRem, adminVchRem, refunds] = await Promise.all([
      queryMainRows<LedgerRow[]>(
        `SELECT ${ledgerDepositCase}, ${ledgerManualWdCase}, ${ledgerBalanceChangeCase}
         FROM ledger_transactions lt
         WHERE lt.status = 'completed' AND lt.created_at >= $2 AND lt.user_id = $1`,
        ...params,
      ),
      queryMainRows<CardRow[]>(
        `SELECT ${cardWdCase}
         FROM card_withdrawal_requests cwr
         WHERE cwr.status IN ('completed', 'shipped')
           AND COALESCE(cwr.shipped_at, cwr.completed_at) >= $2
           AND cwr.user_id = $1`,
        ...params,
      ),
      queryMainRows<InvRow[]>(
        // CREATOR-INVENTORY carve-out (matches calculateWindowedPnl).
        `SELECT ${invObtainedCase}, ${invDisposedCase}
         FROM user_inventory ui
         WHERE (ui.obtained_at >= $2 OR ui.sold_at >= $2 OR ui.exchanged_at >= $2)
           AND ui.user_id = $1
           AND ${nonCreatorOwnerSql("ui.user_id")}`,
        ...params,
      ),
      queryMainRows<VchRow[]>(
        `SELECT ${vchIssuedCase}, ${vchClaimedCase}
         FROM vouchers v
         WHERE (v.created_at >= $2 OR v.claimed_at >= $2)
           AND v.user_id = $1`,
        ...params,
      ),
      queryMainRows<Record<string, string>[]>(
        `SELECT ${adminInvDisposedCase}
         FROM ledger_transactions lt
         WHERE lt.status = 'completed'
           AND lt.created_at >= $2
           AND lt.user_id = $1
           AND lt.type::text = 'admin_balance_adjustment'
           AND lt.metadata->>'kind' = 'inventory_removal'
           AND ${nonCreatorOwnerSql("lt.user_id")}
           AND NOT EXISTS (
             SELECT 1 FROM user_inventory ui2
             WHERE ui2.id::text = lt.metadata->>'inventory_item_id'
           )`,
        ...params,
      ),
      queryMainRows<Record<string, string>[]>(
        `SELECT ${adminVchClaimedCase}
         FROM ledger_transactions lt
         WHERE lt.status = 'completed'
           AND lt.created_at >= $2
           AND lt.user_id = $1
           AND lt.type::text = 'admin_balance_adjustment'
           AND lt.metadata->>'kind' = 'voucher_removal'
           AND NOT EXISTS (
             SELECT 1 FROM vouchers v2
             WHERE v2.id::text = lt.metadata->>'voucher_id'
           )`,
        ...params,
      ),
      queryMainRows<Record<string, string>[]>(
        `SELECT ${fiatRefundCase}
         FROM fiat_deposit_intents i
         WHERE i.status IN ('partially_refunded', 'refunded')
           AND ${fiatRefundAttributionTimestampSql("i")} >= $2
           AND i.user_id = $1`,
        ...params,
      ),
    ]);

    const lRow = ledger[0];
    const cRow = card[0];
    const iRow = inv[0];
    const vRow = vch[0];
    const adminInvRow = adminInvRem[0];
    const adminVchRow = adminVchRem[0];
    const refundRow = refunds[0];

    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      const deposits =
        toNumber(lRow?.[`deposits_${i}`]) -
        toNumber(refundRow?.[`refunds_${i}`]);
      const manualWd = toNumber(lRow?.[`manual_wd_${i}`]);
      const balanceChange = toNumber(lRow?.[`balance_change_${i}`]);
      const cardWd = toNumber(cRow?.[`card_wd_${i}`]);
      const obtained = toNumber(iRow?.[`obtained_${i}`]);
      const disposed =
        toNumber(iRow?.[`disposed_${i}`]) +
        toNumber(adminInvRow?.[`admin_inv_disposed_${i}`]);
      const issued = toNumber(vRow?.[`issued_${i}`]);
      const claimed =
        toNumber(vRow?.[`claimed_${i}`]) +
        toNumber(adminVchRow?.[`admin_vch_claimed_${i}`]);

      const withdrawals = manualWd + cardWd;
      const inventoryChange = obtained - disposed;
      const voucherChange = issued - claimed;
      // Upgrader is fully captured by balanceChange: both
      // upgrader_bet (debit) and upgrader_payout (credit) flow through
      // the ledger. A prior trailing upgraderWon term was based on a
      // stale assumption that the backend skipped upgrader_payout
      // rows; it double-subtracted every upgrader payout and inflated
      // the surfaced house loss in the rolling P&L ladder.
      const pnl =
        deposits -
        withdrawals -
        balanceChange -
        inventoryChange -
        voucherChange;

      result[w.key] = {
        deposits,
        withdrawals,
        balanceChange,
        inventoryChange,
        voucherChange,
        pnl,
      };
    }

    return result;
  });
}
