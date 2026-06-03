import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import type { WindowedPnl } from "./pnl";
import { getRollingPnlWipeCorrections } from "@/lib/account-wipes/rolling-pnl-correction";

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
 * Modeled on `getPnlBreakdownWindows` (`pnl.ts`) which packs three
 * windows into the global breakdown with the same CASE-WHEN-per-window
 * pattern. Same shape, scoped to one user.
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
 *
 * WIPE-AWARE CORRECTION (the FloridaManJeff phantom-loss fix, 2026-06-03)
 * ───────────────────────────────────────────────────────────────────────
 * When an admin wipes a user mid-window the ledger / inventory / voucher
 * rows the wipe DELETED are no longer in the source tables — so the
 * formula's surviving-row sums under-count Δbalance / Δinventory /
 * Δvoucher contributions from those rows. The wipe also atomically
 * subtracts from `available_balance` without writing a ledger row, so the
 * formula can never see the artificial drop. Together this produced a
 * phantom HOUSE LOSS on `/users/[id]` rolling tiles for users with recent
 * wipes (FloridaManJeff showed −$20k Rolling P&L 24h while every actual
 * balance/inventory/voucher/ledger had been reset to $0). We read the wipe
 * snapshots (the recovery copy of every deleted row) and ADD BACK each
 * row's contribution to the window's component aggregates — restricted
 * to rows whose original `created_at`/`obtained_at`/etc. falls inside the
 * window — so the rolling tile reads as the user's REAL trading outcome
 * over the window, treating the wipe as if it never happened. See
 * `src/lib/account-wipes/rolling-pnl-correction.ts` for the full
 * derivation. The Platform-P&L (lifetime balance-sheet) is unaffected.
 */
export async function getUserWindowedPnlMulti(
  userId: string,
  windows: { key: string; since: Date }[],
): Promise<Record<string, WindowedPnl>> {
  const result: Record<string, WindowedPnl> = {};
  if (windows.length === 0) return result;

  return withTiming("pnl.userWindowedMulti", async () => {
    const db = await getDb();

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
          `COALESCE(SUM(CASE WHEN lt.created_at >= ${wParam(i)} AND lt.type::text = 'admin_balance_adjustment' AND lt.balance_after < lt.balance_before AND lt.description ILIKE 'Manual withdrawal:%' THEN lt.amount::numeric ELSE 0 END), 0)::text AS manual_wd_${i}`,
      )
      .join(", ");
    const ledgerBalanceChangeCase = windows
      .map(
        (_, i) =>
          `COALESCE(SUM(CASE WHEN lt.created_at >= ${wParam(i)} THEN (lt.balance_after - lt.balance_before)::numeric ELSE 0 END), 0)::text AS balance_change_${i}`,
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

    const [ledger, card, inv, vch, wipeCorrections] = await Promise.all([
      db.$queryRawUnsafe<LedgerRow[]>(
        `SELECT ${ledgerDepositCase}, ${ledgerManualWdCase}, ${ledgerBalanceChangeCase}
         FROM ledger_transactions lt
         WHERE lt.status = 'completed' AND lt.created_at >= $2 AND lt.user_id = $1`,
        ...params,
      ),
      db.$queryRawUnsafe<CardRow[]>(
        `SELECT ${cardWdCase}
         FROM card_withdrawal_requests cwr
         WHERE cwr.status IN ('completed', 'shipped')
           AND COALESCE(cwr.shipped_at, cwr.completed_at) >= $2
           AND cwr.user_id = $1`,
        ...params,
      ),
      db.$queryRawUnsafe<InvRow[]>(
        `SELECT ${invObtainedCase}, ${invDisposedCase}
         FROM user_inventory ui
         WHERE (ui.obtained_at >= $2 OR ui.sold_at >= $2 OR ui.exchanged_at >= $2)
           AND ui.user_id = $1`,
        ...params,
      ),
      db.$queryRawUnsafe<VchRow[]>(
        `SELECT ${vchIssuedCase}, ${vchClaimedCase}
         FROM vouchers v
         WHERE (v.created_at >= $2 OR v.claimed_at >= $2)
           AND v.user_id = $1`,
        ...params,
      ),
      // Wipe-aware add-back: any deleted ledger / inventory / voucher rows
      // whose original event timestamp fell inside the window are added back
      // to the formula's component aggregates so the rolling tile shows the
      // user's REAL trading outcome, treating the wipe as never-happened.
      // The helper itself swallows admin-DB lookup failures and returns
      // zeroed corrections, so a transient admin-DB hiccup degrades the
      // rolling tile to its pre-correction (post-wipe-phantom) value rather
      // than throwing — same fallback shape as the main reads above.
      getRollingPnlWipeCorrections(userId, windows),
    ]);

    const lRow = ledger[0];
    const cRow = card[0];
    const iRow = inv[0];
    const vRow = vch[0];

    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      const correction = wipeCorrections[w.key];
      const deposits = toNumber(lRow?.[`deposits_${i}`]) + correction.deposits;
      const manualWd = toNumber(lRow?.[`manual_wd_${i}`]) + correction.manualWd;
      const balanceChange =
        toNumber(lRow?.[`balance_change_${i}`]) + correction.balanceDelta;
      const cardWd = toNumber(cRow?.[`card_wd_${i}`]);
      const obtained =
        toNumber(iRow?.[`obtained_${i}`]) + correction.invObtained;
      const disposed =
        toNumber(iRow?.[`disposed_${i}`]) + correction.invDisposed;
      const issued = toNumber(vRow?.[`issued_${i}`]) + correction.vchIssued;
      const claimed = toNumber(vRow?.[`claimed_${i}`]) + correction.vchClaimed;

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
