/**
 * Shared color tokens for the Edge Plan 2.0 planner.
 *
 * Two distinct slots need two distinct token shapes — mixing them is the
 * verified rendering bug this file fixes:
 *
 *  - `CHART_COLOR` holds raw CSS `rgb(...)` strings for slots that take a CSS
 *    color value: Recharts `fill`/`stroke`, `ChartConfig.color`, and inline
 *    `style`. Tailwind class strings silently render no color in these slots.
 *  - `TEXT_TONE` holds Tailwind className tokens for text slots (`className`).
 *
 * Canonical chart-color reference:
 *   src/app/(admin)/insights/cost-breakdown/trend-chart.tsx
 *
 * House-POV finance colors: user gain/profit -> rose, user loss -> emerald,
 * neutral -> blue; house edge / P&L positive -> emerald, negative -> rose.
 */

/** Raw CSS `rgb(...)` values for Recharts fills/strokes, ChartConfig.color, inline style. */
export const CHART_COLOR = {
  emerald: "rgb(16 185 129)",
  rose: "rgb(244 63 94)",
  blue: "rgb(59 130 246)",
  amber: "rgb(245 158 11)",
  neutral: "rgb(100 116 139)",
} as const;

/** Tailwind className tokens for text slots (dark-mode aware). */
export const TEXT_TONE = {
  emerald: "text-emerald-600 dark:text-emerald-400",
  rose: "text-rose-600 dark:text-rose-400",
  blue: "text-blue-600 dark:text-blue-400",
  amber: "text-amber-600 dark:text-amber-400",
} as const;

/**
 * Net-edge magnitude below which the house result is treated as "thin" and
 * shown amber (a near-break-even warning) rather than emerald/rose.
 */
export const THIN_NET_EDGE = 0.02;

/**
 * Chart-fill/stroke color for a house net edge.
 * Positive & healthy -> emerald, positive but thin -> amber, negative -> rose.
 */
export function netEdgeChartColor(netEdge: number): string {
  if (!Number.isFinite(netEdge) || netEdge < 0) return CHART_COLOR.rose;
  if (netEdge < THIN_NET_EDGE) return CHART_COLOR.amber;
  return CHART_COLOR.emerald;
}

/**
 * Text-tone className for a house net edge.
 * Positive & healthy -> emerald, positive but thin -> amber, negative -> rose.
 */
export function netEdgeTextTone(netEdge: number): string {
  if (!Number.isFinite(netEdge) || netEdge < 0) return TEXT_TONE.rose;
  if (netEdge < THIN_NET_EDGE) return TEXT_TONE.amber;
  return TEXT_TONE.emerald;
}

/**
 * House accent for a signed house value (P&L, profit delta, edge): a positive
 * value is good for the house (emerald), a negative value is bad (rose).
 */
export function houseAccent(value: number): "emerald" | "rose" {
  return Number.isFinite(value) && value >= 0 ? "emerald" : "rose";
}
