import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { getCreatorSessionWindowsCte } from "./creator-session-windows";
import type { WindowedPnl } from "./pnl";

/**
 * Multi-window per-user windowed P&L — single round-trip per source
 * table, all windows packed into one SELECT via `SUM(CASE WHEN >= $n
 * THEN <metric> ELSE 0 END)` per window per metric.
 *
 * Background: `calculateWindowedPnl` issues 5 raw queries per call
 * (ledger / card_withdrawal_requests / user_inventory / vouchers /
 * upgrader_games). Callers like `getUserPnlBreakdown` need a rolling
 * P&L ladder across 4 windows — 4 × 5 = 20 round-trips per page render.
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
 *         − upgraderWon
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
    const db = await getDb();

    // Deepest cutoff (earliest `since`) drives the outer WHERE per
    // table. Each per-window CASE compares against its own `since`
    // bind. Rows older than the deepest cutoff are out entirely.
    const deepest = windows.reduce(
      (acc, w) => (w.since < acc ? w.since : acc),
      windows[0].since,
    );

    // Mirrors `calculateWindowedPnl`'s session_windows CTE — needed so
    // creator on-stream upgrader wins (sponsored-balance play) drop
    // out of the upgrader_won term. For a non-creator user the EXISTS
    // short-circuits to false, so the CASE is a no-op.
    const sessionWindowsCte = await getCreatorSessionWindowsCte();

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
          `COALESCE(SUM(CASE WHEN lt.created_at >= ${wParam(i)} AND lt.type = 'deposit' THEN lt.amount::numeric ELSE 0 END), 0)::text AS deposits_${i}`,
      )
      .join(", ");
    const ledgerManualWdCase = windows
      .map(
        (_, i) =>
          `COALESCE(SUM(CASE WHEN lt.created_at >= ${wParam(i)} AND lt.type = 'admin_balance_adjustment' AND lt.balance_after < lt.balance_before AND lt.description ILIKE 'Manual withdrawal:%' THEN lt.amount::numeric ELSE 0 END), 0)::text AS manual_wd_${i}`,
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

    // Upgrader: same session_windows exclusion as
    // `calculateWindowedPnl`'s upgrader query — creator on-stream wins
    // (sponsored-balance play) drop out so they can't surface as a
    // phantom customer-side house loss in the ladder. For a non-
    // creator user the EXISTS branch is never taken.
    const upgraderCase = windows
      .map(
        (_, i) =>
          `COALESCE(SUM(CASE WHEN ug.created_at >= ${wParam(i)} AND NOT (usr.role = 'creator' AND EXISTS (
             SELECT 1 FROM session_windows sw
             WHERE sw.uid = ug.user_id
               AND ug.created_at >= sw.win_start
               AND ug.created_at <  sw.win_end
           )) THEN ug.won_amount::numeric ELSE 0 END), 0)::text AS upgrader_won_${i}`,
      )
      .join(", ");

    type LedgerRow = Record<string, string>;
    type CardRow = Record<string, string>;
    type InvRow = Record<string, string>;
    type VchRow = Record<string, string>;
    type UpgRow = Record<string, string>;

    const [ledger, card, inv, vch, upg] = await Promise.all([
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
      db.$queryRawUnsafe<UpgRow[]>(
        `WITH ${sessionWindowsCte}
         SELECT ${upgraderCase}
         FROM upgrader_games ug
         JOIN "user" usr ON usr.id = ug.user_id
         WHERE ug.created_at >= $2
           AND ug.user_id = $1`,
        ...params,
      ),
    ]);

    const lRow = ledger[0];
    const cRow = card[0];
    const iRow = inv[0];
    const vRow = vch[0];
    const uRow = upg[0];

    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      const deposits = toNumber(lRow?.[`deposits_${i}`]);
      const manualWd = toNumber(lRow?.[`manual_wd_${i}`]);
      const balanceChange = toNumber(lRow?.[`balance_change_${i}`]);
      const cardWd = toNumber(cRow?.[`card_wd_${i}`]);
      const obtained = toNumber(iRow?.[`obtained_${i}`]);
      const disposed = toNumber(iRow?.[`disposed_${i}`]);
      const issued = toNumber(vRow?.[`issued_${i}`]);
      const claimed = toNumber(vRow?.[`claimed_${i}`]);
      const upgraderWon = toNumber(uRow?.[`upgrader_won_${i}`]);

      const withdrawals = manualWd + cardWd;
      const inventoryChange = obtained - disposed;
      const voucherChange = issued - claimed;
      const pnl =
        deposits -
        withdrawals -
        balanceChange -
        inventoryChange -
        voucherChange -
        upgraderWon;

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
