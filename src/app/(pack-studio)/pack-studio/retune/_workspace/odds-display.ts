/**
 * Display-layer reconciliation for planned-odds vectors (Pack Studio Retune).
 *
 * WHY THIS EXISTS (display-only, no engine/write change):
 *   Packs store per-card INTEGER weights; the game computes each card's chance
 *   as weight / Σweights, so the TRUE per-card pcts sum to EXACTLY 100 (a ratio
 *   identity: Σ(w_i / S · 100) = 100). That write path is fair and is NOT
 *   touched here. The bug is purely visual: the planned-% column rounds each
 *   card INDEPENDENTLY (≥1% at flat 2dp, sub-1% at 4 sig-figs), so the buffer
 *   card's true residual (e.g. 42.625%) renders as 42.63% and the VISIBLE
 *   column can sum to 100.005% / 99.99% while the underlying true pcts still
 *   sum to exactly 100. A total-odds readout that sums the raw underlying pcts
 *   then stamps "match 100%" while the column visibly disagrees.
 *
 * THE FIX:
 *   `reconcileOddsForDisplay` rounds the pct vector to a grid-faithful display
 *   precision and DIRECTS THE ENTIRE ROUNDING RESIDUAL INTO THE LARGEST-MASS
 *   ("buffer") entry — the largest-remainder principle collapsed to its
 *   owner-expected form: the buffer is exactly where the leftover belongs. The
 *   returned vector therefore sums to EXACTLY 100 at the chosen precision, and
 *   every surface renders these reconciled values AND sums THEM for its
 *   total-odds readout — so the total can never claim 100 while the column
 *   disagrees.
 *
 * All pcts are percentage values (e.g. `0.0075` means 0.0075%), NOT 0..1
 * fractions — the same convention as `../format-percent`.
 */

import { formatPercent } from "../format-percent";

/** The reconciliation target: a planned odds vector always sums to 100%. */
const TARGET = 100;

/**
 * Round a value to `decimals` decimal places, half away from zero, WITHOUT the
 * binary-float drift of a naive `Math.round(v * 10**d) / 10**d`. Uses the
 * decimal string form so 42.625 → (4dp) 42.625 exactly, not 42.6249999….
 */
function roundTo(v: number, decimals: number): number {
  if (!Number.isFinite(v)) return 0;
  return Number(v.toFixed(decimals));
}

/**
 * Reconcile a vector of planned per-card pcts (each already a %, summing to
 * ~100) into a display vector that sums to EXACTLY 100 at `decimals` places.
 *
 * Mechanic (largest-mass buffer absorption):
 *   1. Round every entry to `decimals` independently (half away from zero).
 *   2. Compute the residual `100 − Σrounded` (the leftover the independent
 *      rounding left on the table — can be + or −).
 *   3. Add the WHOLE residual to the single largest-mass entry (the buffer),
 *      re-rounded to `decimals` so it too stays grid-faithful.
 *
 * Guarantees:
 *   - `Σreturned === 100` to `decimals` precision (residual 0 → vector is the
 *     per-entry rounded vector, unchanged).
 *   - A vector already exactly on the grid is returned unchanged (idempotent).
 *   - Non-buffer clean values are never perturbed — only the buffer carries the
 *     residual, exactly where the owner expects it.
 *   - Sub-1% precision is preserved: `decimals` (default 4) never collapses a
 *     0.0075% jackpot (the buffer, which absorbs the residual, is by definition
 *     the LARGEST entry, never a tiny jackpot).
 *
 * Edge cases:
 *   - empty / single-element vectors → returned rounded as-is (nothing to
 *     reconcile against, or the lone entry IS the buffer).
 *   - a vector that does not sum to ~100 (e.g. a partial/live preview) → still
 *     reconciled so `Σ === 100`; the caller decides whether that's meaningful.
 *   - NaN / non-finite entries → treated as 0 (guarded), never poison the sum.
 *
 * @param pcts     per-card planned pcts (%), length N
 * @param decimals display grid precision (default 4 — up to 4 decimals)
 * @returns a new vector, same length + order, summing to exactly 100 at `decimals`
 */
export function reconcileOddsForDisplay(
  pcts: readonly number[],
  decimals = 4,
): number[] {
  const n = pcts.length;
  if (n === 0) return [];

  // Step 1 — independent per-entry rounding (NaN/non-finite → 0).
  const rounded = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    rounded[i] = roundTo(pcts[i]!, decimals);
  }
  if (n === 1) return rounded;

  // The largest-MASS entry (the buffer) — ties broken by the first index, a
  // stable, deterministic pick. Uses the ORIGINAL (pre-round) magnitude so a
  // rounding tie can't flip which card is the buffer.
  let bufferIdx = 0;
  let bufferMass = Number.isFinite(pcts[0]!) ? pcts[0]! : 0;
  for (let i = 1; i < n; i++) {
    const m = Number.isFinite(pcts[i]!) ? pcts[i]! : 0;
    if (m > bufferMass) {
      bufferMass = m;
      bufferIdx = i;
    }
  }

  // Step 2 — the residual the independent rounding left vs an exact 100.
  let roundedSum = 0;
  for (let i = 0; i < n; i++) roundedSum += rounded[i]!;
  const residual = roundTo(TARGET - roundedSum, decimals);

  // Step 3 — the buffer absorbs the WHOLE residual, re-rounded to the grid.
  // (residual 0 → unchanged; idempotent on an already-on-grid vector.)
  if (residual !== 0) {
    rounded[bufferIdx] = roundTo(rounded[bufferIdx]! + residual, decimals);
  }
  return rounded;
}

/**
 * Format a single reconciled display pct with trailing zeros trimmed, matching
 * the canonical `formatPercent` precision rule for sub-1% odds (4 sig-figs) and
 * up to `decimals` places above 1% — WITHOUT re-flattening a reconciled value
 * to 2dp. `42.625` → "42.625%", `25` → "25%", `0.075` → "0.075%".
 *
 * ≥1% values are rendered at up to `decimals` places (default 4), trailing
 * zeros trimmed (so a clean 25 shows "25%", not "25.0000%"); sub-1% values
 * defer to `formatPercent` so a real 0.0075% jackpot never collapses. Returns
 * the string WITH the trailing `%`.
 */
export function formatReconciledPct(v: number, decimals = 4): string {
  if (!Number.isFinite(v)) return "—";
  if (v === 0) return "0%";
  if (v < 1) return formatPercent(v);
  return `${trimTrailingZeros(v.toFixed(decimals))}%`;
}

/** Strip trailing zeros (and a dangling decimal point) from a fixed string. */
function trimTrailingZeros(s: string): string {
  if (s.indexOf(".") === -1) return s;
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 48 /* '0' */) end--;
  if (end > 0 && s.charCodeAt(end - 1) === 46 /* '.' */) end--;
  return s.slice(0, end);
}
