/**
 * Shared color constants for the upgrader admin page.
 *
 * This file is intentionally NOT `"use server"` and NOT `"server-only"` —
 * the values are consumed by both the server action (`actions.ts`) and
 * the client tile component (`output-cards-grid.tsx`). Mirrors the
 * `rain/config-keys.ts` pattern: keep cross-boundary constants in a
 * plain module so neither side has to bend its import graph.
 *
 * Values must stay aligned with CardRarityTone in the game frontend
 * (`src/lib/cards/theme/card-theme.types.ts`) — the strings stored in
 * `upgrader_output_cards.color` are read directly by `resolveCardTheme`
 * on the player side.
 */
export const UPGRADER_OUTPUT_COLORS = [
  "gray",
  "white",
  "blue",
  "green",
  "purple",
  "red",
  "gold",
] as const;

export type UpgraderOutputColor = (typeof UPGRADER_OUTPUT_COLORS)[number];

/**
 * Default color tone derived from a card's USD price, applied automatically
 * when a card is first added to the upgrader pool. Admins can still override
 * it afterward via the per-card color Select — this only sets the initial
 * value (cards added before are left untouched, see `addUpgraderOutputs`).
 *
 * Thresholds are the lower bound of each tier, ascending and contiguous.
 * Note green sits below blue here (cheaper than blue), unlike a rarity
 * scale — the bands are price-driven:
 *   gray $0–$0.99 · white $1–$14.99 · green $15–$149.99 · blue $150–$499.99 ·
 *   purple $500–$1,499.99 · red $1,500–$4,999.99 · gold $5,000+
 */
export function colorForPrice(priceUsd: number): UpgraderOutputColor {
  if (priceUsd < 1) return "gray";
  if (priceUsd < 15) return "white";
  if (priceUsd < 150) return "green";
  if (priceUsd < 500) return "blue";
  if (priceUsd < 1500) return "purple";
  if (priceUsd < 5000) return "red";
  return "gold";
}
