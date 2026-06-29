/**
 * Shared percent/pp formatting for the Pack Studio Retune surface.
 *
 * Why this exists:
 *   The review-card list and the final "push to production" confirm dialog
 *   render the SAME card-weight-change numbers (tiny share moves on high-value
 *   cards). A flat `toFixed(2)` collapses values < 0.005 to `0.00%` and
 *   small pp moves to `+0.00`, hiding real economic shifts (a 0.0007pp shift
 *   on a $810 card still moves money). Both render sites use these helpers so
 *   the precision rule stays canonical.
 *
 * Rule (kept identical to the previous in-file `formatPercent` /
 * `formatDeltaPp` in `review-card.tsx`, so the main list keeps rendering
 * exactly as it does today):
 *   - `v == 0`  → `0%`  / `0`   (no decimals — clearer than `0.0000%`).
 *   - `v >= 1`  → 2 decimals.
 *   - `v < 1`   → 4 significant digits, trailing zeros trimmed past the
 *                 minimum-2-decimal floor (`0.0075` → `0.0075`, NOT
 *                 `0.007500`).
 *
 * `v` is a percentage value (e.g. `0.0075` means 0.0075%), NOT a 0..1
 * fraction. Callers holding fractions must multiply by 100 first.
 */

/**
 * Format a percentage value (already in %, not 0..1) with the precision rule
 * above. Returns the string WITH the trailing `%` suffix.
 */
export function formatPercent(v: number): string {
  if (v === 0) return "0%";
  if (v >= 1) return `${v.toFixed(2)}%`;
  // 4 significant digits: 10^floor(log10(v)) gives the leading digit's place,
  // so digits-after-decimal = 4 − (floor(log10(v)) + 1) = 3 − floor(log10(v)).
  const mag = Math.floor(Math.log10(v));
  const decimals = Math.min(10, Math.max(2, 3 - mag));
  return `${trimZeros(v.toFixed(decimals), 2)}%`;
}

/**
 * Format the |numeric body| of a pp delta with the same precision rule as
 * `formatPercent`. Returns the numeric body only — the caller prepends sign
 * (and unit suffix like "pp" if desired). Input is the ABSOLUTE move in pp,
 * so a tiny shift (e.g. 0.0007pp on a high-value card) doesn't collapse to
 * `+0.00`.
 */
export function formatDeltaPp(absMove: number): string {
  if (absMove === 0) return "0";
  if (absMove >= 1) return absMove.toFixed(2);
  const mag = Math.floor(Math.log10(absMove));
  const decimals = Math.min(10, Math.max(2, 3 - mag));
  return trimZeros(absMove.toFixed(decimals), 2);
}

/**
 * Strip trailing zeros after the decimal, but always keep at least
 * `minDecimals` digits (so `12.30` doesn't become `12.3` when the column
 * expects 2 decimals). Drops a dangling decimal point.
 */
function trimZeros(s: string, minDecimals: number): string {
  const dot = s.indexOf(".");
  if (dot === -1) return s;
  const minLen = dot + 1 + minDecimals;
  let end = s.length;
  while (end > minLen && s.charCodeAt(end - 1) === 48 /* '0' */) end--;
  if (s.charCodeAt(end - 1) === 46 /* '.' */) end--;
  return s.slice(0, end);
}
