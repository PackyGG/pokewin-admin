/**
 * Client-safe formatters for the sample-guarded metric values the
 * /insights/games query layer now emits.
 *
 * Empirical RTP / margin fields are `number | null` — `null` is the
 * canonical "insufficient sample" sentinel (`bets < MIN_SAMPLE`, see
 * `@/lib/metrics/formulas`). A bucket below the threshold is dominated by
 * variance, so rendering a concrete −14.92% / 114.92% / >100% there would
 * present small-sample noise as fact. These helpers render the sentinel
 * instead, and never recompute a ratio themselves — they only format the
 * value the (canonical-sourced) payload already carries.
 *
 * Dep-free + no server imports so any "use client" component can call
 * them.
 */

/** Full sentinel for table cells / panels that have room for the reason. */
export const INSUFFICIENT_SAMPLE_LABEL = "n/a — insufficient sample";
/** Compact sentinel for tight KPI tiles / sub-labels. */
export const INSUFFICIENT_SAMPLE_SHORT = "n/a";

/**
 * Format a percentage value (already ×100) that may be the
 * insufficient-sample sentinel. `null` → the supplied sentinel text;
 * otherwise `"12.34%"`.
 */
export function formatPctOrNa(
  pct: number | null,
  decimals = 2,
  sentinel: string = INSUFFICIENT_SAMPLE_LABEL,
): string {
  if (pct === null || !Number.isFinite(pct)) return sentinel;
  return `${pct.toFixed(decimals)}%`;
}
