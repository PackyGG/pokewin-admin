/**
 * ──────────────────────────────────────────────────────────────────────────
 *  House-POV finance colors  (pokewin-admin · src/lib/house-pov.ts)
 * ──────────────────────────────────────────────────────────────────────────
 *
 * ONE source of truth for the House-Perspective color rule mandated in
 * CLAUDE.md. The rule, restated:
 *
 *   - We are the HOUSE. Every dollar a player holds is a dollar we owe.
 *   - HOUSE up (we kept money / P&L positive / edge positive) → 🟢 emerald.
 *   - HOUSE down (we paid out / P&L negative / edge negative)  → 🔴 rose.
 *   - Neutral event (signup, status, info)                     → 🔵 blue.
 *
 * Today this rule is re-derived by hand in dozens of places (the dashboard's
 * upgrader-stats, every pack/card surface, …) with copy-pasted
 * `x >= 0 ? "text-emerald-…" : "text-rose-…"` ternaries and a duplicated
 * `value > 2 ? value : value * 100` heuristic for normalizing RTP/edge. That
 * duplication is exactly how the colors drift out of sync. These helpers
 * centralize it so the `/packs` + `/cards` rebuild (and anything after) reads
 * one function instead of re-typing the ternary.
 *
 * All classes use the existing theme tokens / Tailwind color scale already in
 * the constants color-maps — no new colors, dark-mode native.
 *
 * Pure functions, no React, no deps. Safe to import from Server or Client
 * components.
 */

import { type AccentColor } from "@/components/modern-panels";

/** A house outcome's polarity. `positive` = house gained, `negative` = house
 * paid out / lost, `neutral` = informational (no money direction). */
export type HousePolarity = "positive" | "negative" | "neutral";

/**
 * Map a signed amount (already expressed from the HOUSE perspective — i.e. a
 * house P&L / GGR / edge figure where >0 means we kept money) to a polarity.
 *
 * `zeroIsNeutral` (default false): treat an exact 0 as `neutral` (blue) rather
 * than `positive`. Use it for a break-even figure that reads better grey/blue
 * than green. Default folds 0 into `positive` because "we didn't lose" is, from
 * the house's side, the non-alarming case.
 */
export function housePolarity(
  houseAmount: number,
  { zeroIsNeutral = false }: { zeroIsNeutral?: boolean } = {},
): HousePolarity {
  if (!Number.isFinite(houseAmount)) return "neutral";
  if (houseAmount === 0) return zeroIsNeutral ? "neutral" : "positive";
  return houseAmount > 0 ? "positive" : "negative";
}

/** Tailwind text-color class for a house-POV polarity. */
export function houseTextClass(polarity: HousePolarity): string {
  switch (polarity) {
    case "positive":
      return "text-emerald-600 dark:text-emerald-400";
    case "negative":
      return "text-rose-600 dark:text-rose-400";
    case "neutral":
      return "text-blue-600 dark:text-blue-400";
  }
}

/**
 * Convenience: text-color class straight from a signed house amount.
 *
 *   <span className={houseAmountTextClass(pack.houseEdgePct)}>…</span>
 */
export function houseAmountTextClass(
  houseAmount: number,
  opts?: { zeroIsNeutral?: boolean },
): string {
  return houseTextClass(housePolarity(houseAmount, opts));
}

/**
 * The `TILE_COLORS` accent token for a house-POV polarity — for tiles/panels
 * that take an `accent` prop (KpiTile, StatPanel, MetricTile). Keeps the tile
 * accent in lockstep with the value's text color.
 *
 *   <KpiTile accent={houseAccent(stats.pnl)} … />
 */
export function houseAccent(
  houseAmount: number,
  opts?: { zeroIsNeutral?: boolean },
): AccentColor {
  const polarity = housePolarity(houseAmount, opts);
  return polarity === "positive"
    ? "emerald"
    : polarity === "negative"
      ? "rose"
      : "blue";
}

/**
 * Soft gradient-`from` classes for a house-POV polarity — for the subtle wash
 * behind a hero number (matches the upgrader-stats panel treatment). Returns
 * the `from-…/15 via-…/5 to-transparent` triple as one string.
 */
export function houseGradientClass(polarity: HousePolarity): string {
  switch (polarity) {
    case "positive":
      return "from-emerald-500/15 via-emerald-500/5 to-transparent";
    case "negative":
      return "from-rose-500/15 via-rose-500/5 to-transparent";
    case "neutral":
      return "from-blue-500/15 via-blue-500/5 to-transparent";
  }
}

// ─── Pack economics normalization (the `> 2` heuristic, centralized) ─────────

/**
 * Normalize a stored RTP / house-edge value to a PERCENT number.
 *
 * The pack queries store these as either a fraction (0.89 = 89%) or already as
 * a percent (89), depending on the path that wrote them. The live code
 * disambiguates with the heuristic `value > 2 ? value : value * 100` — a raw
 * RTP/edge is never a sane "2" as a fraction (that'd be 200%) but is common as
 * a percent, so a value above 2 is assumed already-percent. This was copy-
 * pasted in columns.tsx (×2) and data-table.tsx; hoisting it here kills the
 * magic-number drift the discovery flagged.
 *
 * Returns a percent number (e.g. 89.0). Non-finite input → 0.
 */
export function toPercent(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return 0;
  return value > 2 ? value : value * 100;
}

/**
 * Format a normalized RTP/edge percent for display, e.g. `89.0%`. Pass the
 * RAW stored value; normalization is applied internally.
 */
export function formatPercentValue(
  value: number | null | undefined,
  fractionDigits = 1,
): string {
  return `${toPercent(value).toFixed(fractionDigits)}%`;
}
