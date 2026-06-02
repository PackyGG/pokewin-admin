import "server-only";

/**
 * Thin adapter between the canonical metric layer (`@/lib/metrics`) and
 * the /insights/games query payloads.
 *
 * The canonical `empiricalRtp` / `empiricalHouseEdge` helpers return an
 * `EmpiricalRatio` — a 0..1 fraction, or `null` when the bucket is below
 * `MIN_SAMPLE` (the "insufficient sample" sentinel that prevents a
 * small-sample −14.92% / 114.92% / >100% figure from being rendered as
 * fact). The /insights/games surfaces have historically expressed RTP /
 * margin as PERCENTAGES, and the CSV export columns are labelled "%". To
 * keep those payload/column shapes stable while sourcing the arithmetic
 * from the single canonical formula, this helper maps the canonical
 * fraction → percentage and PRESERVES the `null` sentinel end-to-end.
 *
 * Using this everywhere a query needs a "% RTP / % margin" field means no
 * module re-derives `payout / wager * 100` inline — they all call the
 * canonical formula and pass its output through here.
 */
export function ratioToPct(ratio: number | null): number | null {
  return ratio === null ? null : ratio * 100;
}
