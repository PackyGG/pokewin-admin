import "server-only";

import { adminDb } from "@/lib/admin-db";
import type { AccountWipeType } from "./snapshot";

/**
 * rolling-pnl-correction.ts — wipe-aware correction for the per-user windowed
 * (rolling) P&L tiles on `/users/[id]` (12h / 24h / 3d / 7d / 14d).
 *
 * ─── THE BUG THIS GUARDS AGAINST ─────────────────────────────────────────
 *
 * The rolling-P&L formula in `users-windowed-pnl.ts` / `pnl.ts`
 * (`calculateWindowedPnl`) is:
 *
 *   pnl = Δdeposits − Δwithdrawals − Δbalance − Δinventory − Δvoucher
 *
 * Δbalance is derived from `SUM(balance_after − balance_before)` over the
 * SURVIVING ledger rows in the window. Δinventory and Δvoucher come from
 * sums over the still-present `user_inventory` / `vouchers` rows.
 *
 * When an admin wipes the user mid-window the wipe DELETES rows from the
 * ledger / inventory / voucher tables AND (for the destructive types) does
 * an atomic raw-SQL UPDATE on `balances.available_balance` with NO matching
 * ledger row. The formula then sees:
 *
 *   • fewer surviving rows → Δbalance / Δinventory / Δvoucher contributions
 *     from the deleted rows are MISSING from the sums,
 *   • for balance / vault wipes there are no rows deleted, but the atomic
 *     `available_balance = 0` is also invisible to the ledger-sum.
 *
 * The owner's instruction is that the rolling P&L should reflect the
 * actual balance trajectory across the window — wipes that artificially
 * zeroed balance must be MATERIALISED in Δbalance, not hidden because no
 * ledger row was written. We read the wipe snapshots and apply TWO
 * corrections per wipe inside the window:
 *
 *   1. ADD-BACK of every DELETED row's contribution to the formula's
 *      sums — so the surviving-row aggregates that the formula computes
 *      see the rows as if they were still there.
 *   2. SUBTRACT the wipe's atomic balance reduction from Δbalance — the
 *      amount the wipe took from `available_balance` with NO matching
 *      ledger row. The formula's surviving-row sum never sees this drop,
 *      so we subtract it explicitly to keep Δbalance aligned with the
 *      actual end-of-window balance.
 *
 * ─── THE INVARIANT (why both corrections together work) ──────────────────
 *
 * Let `D` = sum of deleted-row deltas in window, `W` = wipe's atomic
 * balance reduction. Each row's `(balance_after − balance_before)`
 * REFLECTS its contribution to the balance trajectory. With no wipe at
 * all:
 *
 *   actual_Δbalance = sum_all_rows_deltas = bc_formula + D
 *
 * With the wipe, the wipe additionally subtracts `W` from the balance
 * with no ledger row to record it:
 *
 *   actual_Δbalance (with wipe) = bc_formula + D − W
 *
 * So the corrected Δbalance is `bc_formula + (D − W)`. The helper folds
 * `D − W` into `correction.balanceDelta`: deleted-row deltas go in as
 * `+= delta` (the D portion), the wipe reduction goes in as
 * `-= wipeBalanceReduction` (the −W portion). Caller adds the correction
 * to its raw aggregate.
 *
 * For each wipe type:
 *   • balance wipe: D = 0 (no rows deleted), W = `availableBalanceBefore`.
 *     Net Δbalance correction = −W.
 *   • wager / game wipe: D = ΣpayoutΔ + ΣwagerΔ = payoutMag − wagerMag,
 *     W = payoutMag. Net = −wagerMag.
 *   • pnl wipe: D = sum of all deleted row deltas (deposits / withdrawals
 *     / rewards / wagers / payouts / admin adjustments), W =
 *     `availableBalanceReduction` (the credit-leg clawback). Net is what
 *     the actual balance trajectory dropped beyond the surviving-row sum.
 *   • deposits wipe: D = Σ deleted deposit deltas, W = 0. Δbalance gains
 *     `+D` (deleted credits restored). The matching `deposits` term ALSO
 *     gains `+D`, so the formula's `+deposits − Δbalance` self-cancels and
 *     pnl is unchanged — correct: the deposits wipe didn't move pnl.
 *   • inventory wipe: D = 0 in ledger, W = 0 in balance, but `obtained`
 *     and `disposed` aggregates miss the deleted rows — those are added
 *     back via `invObtained` / `invDisposed`.
 *   • vault wipe: doesn't move `available_balance` (only `locked_balance`),
 *     so no correction at the windowed level (rolling P&L tracks the
 *     ledger-summable available_balance trajectory, not the vault pool).
 *
 * ─── SCOPE ───────────────────────────────────────────────────────────────
 *
 * This helper is ONLY used by the per-user rolling-P&L surface
 * (`getUserWindowedPnlMulti`). The canonical metric layer that powers the
 * global Dashboard / GGR / Insights surfaces is untouched — those use
 * different aggregates and are scoped over the whole user base, where the
 * per-user wipe correction would be pathologically expensive AND already
 * naturally excludes creators / staff (FloridaManJeff is a creator and the
 * customer-only scope drops him from the canonical metrics regardless).
 */

/** A single wipe-snapshot row's relevant fields for the correction. */
type RawWipeRow = {
  wipe_type: string;
  wiped_at: Date;
  snapshot: unknown;
};

/** Inner snapshot shape we read — only the fields we need (defensive). */
type SnapshotLedgerRow = Record<string, unknown>;
type SnapshotInventoryRow = Record<string, unknown>;
type SnapshotVoucherRow = Record<string, unknown>;

/**
 * Per-window correction record. Each field is the amount to ADD to the
 * corresponding component of the rolling-P&L formula so it matches the
 * as-if-no-wipe value. Always ≥ 0 for the magnitudes (deposits, manual_wd,
 * obtained, disposed, issued, claimed); `balanceDelta` can be either sign
 * because it is the signed sum of `(balance_after − balance_before)` across
 * the deleted rows.
 */
export type RollingPnlCorrection = {
  deposits: number;
  manualWd: number;
  balanceDelta: number;
  invObtained: number;
  invDisposed: number;
  vchIssued: number;
  vchClaimed: number;
};

const ZERO_CORRECTION: RollingPnlCorrection = {
  deposits: 0,
  manualWd: 0,
  balanceDelta: 0,
  invObtained: 0,
  invDisposed: 0,
  vchIssued: 0,
  vchClaimed: 0,
};

/** Wipe types that delete rows from the formula's source tables. */
const ROW_DELETING_WIPE_TYPES: ReadonlySet<AccountWipeType> = new Set([
  "deposits",
  "wager",
  "game",
  "pnl",
  // Inventory wipe deletes user_inventory rows.
  "inventory",
]);

/** Wipe types that atomically reduce `available_balance` with NO ledger row. */
const BALANCE_REDUCING_WIPE_TYPES: ReadonlySet<AccountWipeType> = new Set([
  "balance",
  "wager",
  "game",
  "pnl",
]);

/**
 * Pull the snapshotted balance-reduction amount for a wipe (the EXACT amount
 * the wipe atomically subtracted from `available_balance`). The field name
 * differs per snapshot type:
 *   • balance  → `availableBalanceBefore` (the entire balance was zeroed).
 *   • wager / game → `balanceReduction` (the credit-leg clawback magnitude).
 *   • pnl → `availableBalanceReduction` (the credit-leg clawback magnitude).
 * Returns `0` for the other wipe types (vault doesn't move available_balance,
 * inventory / deposits don't either — handled via row corrections instead).
 */
function readWipeBalanceReduction(
  wipeType: string,
  snapshot: Record<string, unknown>,
): number {
  switch (wipeType) {
    case "balance":
      return toNumberSafe(snapshot["availableBalanceBefore"]);
    case "wager":
    case "game":
      return toNumberSafe(snapshot["balanceReduction"]);
    case "pnl":
      return toNumberSafe(snapshot["availableBalanceReduction"]);
    default:
      return 0;
  }
}

function toNumberSafe(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof v === "object" && v !== null) {
    // Decimal.js post-JSON sometimes survives as `{ s,e,d }` if the replacer
    // wasn't applied — defensive `String(v)` round-trip handles that.
    const n = Number(String(v));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function toDateSafe(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function isInsideWindow(ts: Date | null, windowStart: Date): boolean {
  if (!ts) return false;
  return ts.getTime() >= windowStart.getTime();
}

/**
 * Look up the user's wipes that overlap the deepest window and fold each
 * deleted row's contribution into a per-window correction record.
 *
 * Returns a record keyed by the same `key` strings the caller passed in for
 * the windows. A window with no wipes inside it gets a `ZERO_CORRECTION`
 * entry, so the caller can blindly add the correction to every window
 * without a null check.
 *
 * Implementation notes:
 *   • Only `status = 'completed'` snapshots are considered — pending /
 *     failed rows do NOT represent a delete that landed in the main DB.
 *   • Restored snapshots (`restored_at IS NOT NULL`) are SKIPPED because
 *     the deleted rows have been put back, so the formula already sees
 *     them — applying the correction on top would double-count.
 *   • `wiped_at >= deepestWindowStart` is the outer time-bound: a wipe
 *     before any window's start can't have deleted rows that fall in any
 *     of the windows (rows in window have `created_at`/`obtained_at`/etc.
 *     ≥ window_start ≥ deepestWindowStart, and a wipe at time T can only
 *     delete rows with ts ≤ T — so a wipe before deepest_start can only
 *     have deleted rows that are also before deepest_start, none of
 *     which contribute to any window).
 */
export async function getRollingPnlWipeCorrections(
  userId: string,
  windows: { key: string; since: Date }[],
): Promise<Record<string, RollingPnlCorrection>> {
  const result: Record<string, RollingPnlCorrection> = {};
  for (const w of windows) result[w.key] = { ...ZERO_CORRECTION };
  if (windows.length === 0) return result;

  const deepestWindowStart = windows.reduce(
    (acc, w) => (w.since < acc ? w.since : acc),
    windows[0].since,
  );

  // ensure-schema is best-effort. If the table is missing we degrade to "no
  // wipes recorded" (the formula stays as-is) rather than crashing the page —
  // pre-wipe-feature snapshots simply don't exist, so the zero correction is
  // also the correct answer.
  let rows: RawWipeRow[];
  try {
    rows = await adminDb.admin_account_wipes.findMany({
      where: {
        user_id: userId,
        status: "completed",
        restored_at: null,
        wiped_at: { gte: deepestWindowStart },
      },
      select: { wipe_type: true, wiped_at: true, snapshot: true },
    });
  } catch (err) {
    console.error(
      "[rolling-pnl-correction] admin_account_wipes lookup failed:",
      err instanceof Error ? err.message : err,
    );
    return result;
  }

  if (rows.length === 0) return result;

  for (const row of rows) {
    const wipeType = row.wipe_type as AccountWipeType;
    const wipedAt = row.wiped_at;
    const snapshot = row.snapshot;
    if (!snapshot || typeof snapshot !== "object") continue;
    const snapshotObj = snapshot as Record<string, unknown>;

    const isRowDeleting = ROW_DELETING_WIPE_TYPES.has(wipeType);
    const isBalanceReducing = BALANCE_REDUCING_WIPE_TYPES.has(wipeType);
    if (!isRowDeleting && !isBalanceReducing) continue;

    // The wipe's atomic balance reduction (the amount that disappeared from
    // the user's `available_balance` with NO matching ledger row). Subtracted
    // from `balanceDelta` for every window the wipe falls inside, so the
    // rolling tile's Δbalance reflects the actual balance trajectory
    // (including the artificial drop) instead of the surviving-row sum that
    // doesn't see the drop. Returns 0 for inventory / deposits / vault wipes
    // — those don't reduce available_balance.
    const wipeBalanceReduction = isBalanceReducing
      ? readWipeBalanceReduction(wipeType, snapshotObj)
      : 0;

    const ledgerRows = isRowDeleting ? readArray(snapshot, "ledgerRows") : [];
    const inventoryRows = isRowDeleting
      ? readArray(snapshot, "inventoryRows")
      : [];
    const voucherRows = isRowDeleting ? readArray(snapshot, "voucherRows") : [];
    // Deposits wipe stores deleted deposit rows under `rows` (its only
    // ledger field), distinct from the other wipes' `ledgerRows`.
    const depositRowsAlt =
      isRowDeleting && wipeType === "deposits" ? readArray(snapshot, "rows") : [];
    // Inventory wipe stores rows under `rows`, not `inventoryRows`.
    const invRowsAlt =
      isRowDeleting && wipeType === "inventory"
        ? readArray(snapshot, "rows")
        : [];

    for (const w of windows) {
      const correction = result[w.key];
      const windowStart = w.since;

      // Only apply the wipe's balance-reduction correction if the wipe
      // itself happened INSIDE the window — a wipe that ran before the
      // window started is part of the pre-window state, not a Δbalance
      // event the rolling tile should reflect.
      if (isBalanceReducing && wipedAt.getTime() >= windowStart.getTime()) {
        correction.balanceDelta -= wipeBalanceReduction;
      }

      // --- Ledger rows (wager / game / pnl wipes + the deposits-only wipe).
      const allLedger =
        depositRowsAlt.length > 0 ? depositRowsAlt : ledgerRows;
      for (const lr of allLedger) {
        const createdAt = toDateSafe(lr["created_at"]);
        if (!isInsideWindow(createdAt, windowStart)) continue;
        const status =
          typeof lr["status"] === "string" ? (lr["status"] as string) : null;
        // The formula only sums completed rows; skip anything else so we
        // mirror its filter exactly.
        if (status !== "completed") continue;
        const balanceBefore = toNumberSafe(lr["balance_before"]);
        const balanceAfter = toNumberSafe(lr["balance_after"]);
        correction.balanceDelta += balanceAfter - balanceBefore;
        const type =
          typeof lr["type"] === "string" ? (lr["type"] as string) : null;
        const amount = toNumberSafe(lr["amount"]);
        const description =
          typeof lr["description"] === "string"
            ? (lr["description"] as string)
            : "";
        if (type === "deposit") {
          correction.deposits += amount;
        } else if (
          type === "admin_balance_adjustment" &&
          balanceAfter < balanceBefore &&
          /^Manual withdrawal:/i.test(description)
        ) {
          correction.manualWd += amount;
        }
      }

      // --- Inventory rows (wager / game / pnl wipes + the inventory wipe).
      const allInv =
        invRowsAlt.length > 0 ? invRowsAlt : inventoryRows;
      for (const ir of allInv) {
        const value = toNumberSafe(ir["value_at_obtained"]);
        if (value <= 0) continue;
        const obtainedAt = toDateSafe(ir["obtained_at"]);
        const soldAt = toDateSafe(ir["sold_at"]);
        const exchangedAt = toDateSafe(ir["exchanged_at"]);
        if (isInsideWindow(obtainedAt, windowStart)) {
          correction.invObtained += value;
        }
        if (
          isInsideWindow(soldAt, windowStart) ||
          isInsideWindow(exchangedAt, windowStart)
        ) {
          correction.invDisposed += value;
        }
      }

      // --- Voucher rows (pnl wipe only).
      for (const vr of voucherRows) {
        const value = toNumberSafe(vr["value"]);
        if (value <= 0) continue;
        const createdAt = toDateSafe(vr["created_at"]);
        const claimedAt = toDateSafe(vr["claimed_at"]);
        if (isInsideWindow(createdAt, windowStart)) {
          correction.vchIssued += value;
        }
        if (isInsideWindow(claimedAt, windowStart)) {
          correction.vchClaimed += value;
        }
      }
    }
  }

  return result;
}

/**
 * GUARANTEED-FIX wipe-in-window DETECTOR (2026-06-03 — the FloridaManJeff
 * phantom-loss fix, take 3).
 *
 * ─── WHY DETECT INSTEAD OF CORRECT ────────────────────────────────────────
 *
 * A windowed P&L (deposits − withdrawals − Δbalance − Δinventory − Δvoucher
 * over a fixed window) is mathematically UNDEFINED once an admin wipe lands
 * inside the window. The wipe atomically (a) DELETES ledger / inventory /
 * voucher rows AND (b) drops `available_balance` with NO matching ledger row.
 * After the wipe the surviving-row Δbalance no longer reconciles with the
 * pre-window balance, so the formula reports a PHANTOM house loss (Florida-
 * ManJeff: −$18k…−$20k rolling tiles while every real counter was reset to
 * $0). The add-back correction (commits c836684 / 70be8d3) tried to re-
 * materialise the deleted rows + the atomic drop from the wipe snapshots, but
 * it kept returning a ~0 net correction for him (see the REPORT note below),
 * so the phantom survived two deploys.
 *
 * The robust fix is NOT to correct the undefined value — it's to DETECT that
 * the window crosses a wipe and render that window as a RESET ("—"), deferring
 * the user to the lifetime Platform-P&L (which reads live balance counters +
 * card_withdrawal_requests and is unaffected by the wipe).
 *
 * ─── WHAT THIS RETURNS ────────────────────────────────────────────────────
 *
 * A record keyed by the same window `key` strings the caller passed in, each
 * mapping to a boolean `wipedInWindow`:
 *   • true  → at least one completed, un-restored wipe has `wiped_at` ≥ that
 *             window's `since`. The window crosses a wipe → render "—".
 *   • false → no qualifying wipe in that window → the formula's value is
 *             well-defined → render the computed number normally.
 *
 * ─── FAILURE SEMANTICS (deliberately NOT a silent swallow) ────────────────
 *
 * If the admin-DB lookup throws we CANNOT prove the windows are wipe-free, so
 * — per the owner's "default to the reset state, never the phantom" mandate —
 * we default EVERY window to `wipedInWindow = true`. The blast radius of a
 * transient admin-DB hiccup is then "rolling-P&L tiles show '—' instead of a
 * number" (recoverable, honest) rather than "a phantom −$18k is shown as a
 * real loss" (the exact bug we're killing). The failure is logged DISTINCTLY
 * so it's visible upstream — unlike the correction helper, which logged-and-
 * zeroed and so let the phantom through unnoticed.
 *
 * BOTH wipe stores are checked (this is critical — see the REPORT note on why
 * the prior add-back correction returned ~0):
 *   • `admin_account_wipes`            — the balance / vault / inventory /
 *                                        deposits / wager / game / pnl wipes.
 *   • `admin_balance_adjustment_wipes` — the "wipe balance adjustments" action,
 *                                        a SEPARATE table. It ALSO atomically
 *                                        reduces `available_balance` with no
 *                                        compensating ledger row, so it equally
 *                                        breaks the windowed-P&L formula — yet
 *                                        the add-back correction never reads it,
 *                                        which is a primary reason that fix
 *                                        under-corrected. FloridaManJeff's
 *                                        ~3h-ago wipes live in THIS table.
 *
 * Both use the SAME relevant columns (`user_id` = the main-DB user id the wipe
 * acted on, `wiped_at`, `status`, `restored_at` — see prisma/admin/schema.prisma;
 * there is NO `target_user_id` column on either table) and the SAME filter as
 * the correction (`status = 'completed'`, `restored_at IS NULL`,
 * `wiped_at >= deepestWindowStart`). General behaviour for ANY wiped user — not
 * hardcoded to one account.
 *
 * If EITHER lookup throws we default EVERY window to the reset (true) — we
 * can't prove the windows are wipe-free, so we never risk surfacing the
 * phantom. The failure is logged distinctly (NOT swallowed).
 */
export async function getWipedWindows(
  userId: string,
  windows: { key: string; since: Date }[],
): Promise<Record<string, boolean>> {
  const result: Record<string, boolean> = {};
  for (const w of windows) result[w.key] = false;
  if (windows.length === 0) return result;

  const deepestWindowStart = windows.reduce(
    (acc, w) => (w.since < acc ? w.since : acc),
    windows[0].since,
  );

  let wipedAts: Date[];
  try {
    // Both stores in parallel; each row carries only `wiped_at`. A wipe in
    // EITHER store at/after a window's start makes that window "wiped".
    const [accountWipes, adjustmentWipes] = await Promise.all([
      adminDb.admin_account_wipes.findMany({
        where: {
          user_id: userId,
          status: "completed",
          restored_at: null,
          wiped_at: { gte: deepestWindowStart },
        },
        select: { wiped_at: true },
      }),
      adminDb.admin_balance_adjustment_wipes.findMany({
        where: {
          user_id: userId,
          status: "completed",
          restored_at: null,
          wiped_at: { gte: deepestWindowStart },
        },
        select: { wiped_at: true },
      }),
    ]);
    wipedAts = [
      ...accountWipes.map((r) => r.wiped_at),
      ...adjustmentWipes.map((r) => r.wiped_at),
    ];
  } catch (err) {
    // Can't determine wipe state → default to the RESET for every window so
    // the phantom can never surface. Logged distinctly (NOT swallowed).
    console.error(
      "[rolling-pnl-correction] getWipedWindows lookup FAILED — defaulting all windows to reset ('—') for safety:",
      err instanceof Error ? err.message : err,
    );
    for (const w of windows) result[w.key] = true;
    return result;
  }

  if (wipedAts.length === 0) return result;

  // A window is "wiped" iff any completed, un-restored wipe's `wiped_at` falls
  // at/after that window's start. Deeper windows (earlier `since`) therefore
  // catch a superset of the wipes the shallower windows catch.
  for (const w of windows) {
    const start = w.since.getTime();
    result[w.key] = wipedAts.some((t) => t.getTime() >= start);
  }
  return result;
}

/**
 * Whether a user has any wipe with `wiped_at` inside the given window — for
 * the small "wiped Xh ago" badge surfaced alongside the corrected rolling
 * tiles. The correction makes the number meaningful again, but the badge is
 * still surfaced as a transparency signal (admins can see at a glance that
 * the rolling-P&L window crosses a wipe and includes a synthetic add-back).
 */
export async function listRecentWipesForUser(
  userId: string,
  since: Date,
): Promise<Array<{ wipeType: string; wipedAt: Date }>> {
  try {
    const rows: Array<{ wipe_type: string; wiped_at: Date }> =
      await adminDb.admin_account_wipes.findMany({
        where: {
          user_id: userId,
          status: "completed",
          restored_at: null,
          wiped_at: { gte: since },
        },
        select: { wipe_type: true, wiped_at: true },
        orderBy: { wiped_at: "desc" },
      });
    return rows.map((r) => ({ wipeType: r.wipe_type, wipedAt: r.wiped_at }));
  } catch (err) {
    console.error(
      "[rolling-pnl-correction] listRecentWipesForUser failed:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

function readArray(
  obj: object,
  key: string,
): Array<Record<string, unknown>> {
  const v = (obj as Record<string, unknown>)[key];
  if (Array.isArray(v)) {
    // Defensive: ensure each element is a plain object.
    return v.filter(
      (x): x is SnapshotLedgerRow | SnapshotInventoryRow | SnapshotVoucherRow =>
        x !== null && typeof x === "object",
    );
  }
  return [];
}
