/**
 * Compact integer formatter for the Creator Check tool (followers, views,
 * tweet/engagement counts). e.g. 1234 → "1.2K", 2_500_000 → "2.5M".
 *
 * Lives here (not in `@/lib/utils/format`) because the shared format module
 * only exposes `formatCompactUsd` (currency) + locale `formatNumber`; this is
 * a non-currency compact count used in a few Creator-Check surfaces. Kept tiny
 * and dependency-free (Intl), no new lib.
 */
const COMPACT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function compactCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return COMPACT.format(n);
}
