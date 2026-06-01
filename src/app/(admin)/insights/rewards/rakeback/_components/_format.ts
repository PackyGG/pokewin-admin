/**
 * Shared formatting helpers for the rakeback insights tabs.
 *
 * `formatHours` and `formatDeltaSub` are duplicated across the rewards
 * surfaces; pulling them into a tab-local helper keeps each tab file
 * focused on layout rather than re-importing the same utility from
 * several different sibling files.
 */

/**
 * Pretty-print an hours-since duration. Sub-hour → minutes, sub-day
 * → hours, then days. Defensive against NaN / negative values which
 * would imply clock skew or empty data.
 */
export function formatHours(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return "—";
  if (hours < 1) {
    const mins = Math.round(hours * 60);
    return `${mins}m`;
  }
  if (hours < 24) {
    return `${hours.toFixed(1)}h`;
  }
  const days = hours / 24;
  return `${days.toFixed(1)}d`;
}

/**
 * Format a period-over-period delta as a compact sub-label string
 * matching the existing KpiTile sub contract (string only). The arrow
 * glyph encodes the direction; the surrounding tile chooses the accent.
 * Returns the fallback when delta is null (typical for "all" which has
 * no prior frame).
 */
export function formatDeltaSub(
  delta: number | null,
  fallback: string,
): string {
  if (delta === null) return fallback;
  if (delta === 0) return "no change vs prior";
  const isUp = delta > 0;
  const arrow = isUp ? "▲" : "▼";
  const pct = `${(Math.abs(delta) * 100).toFixed(1)}%`;
  return `${arrow} ${pct} vs prior`;
}
