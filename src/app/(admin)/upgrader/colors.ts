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
 * Thresholds are the lower bound of each tier, ascending and contiguous:
 *   gray  $0–$0.99 · white $1–$9.99 · blue $10–$49.99 · green $50–$199.99 ·
 *   purple $200–$599.99 · red $600–$1,799.99 · gold $1,800+
 */
export function colorForPrice(priceUsd: number): UpgraderOutputColor {
  if (priceUsd < 1) return "gray";
  if (priceUsd < 10) return "white";
  if (priceUsd < 50) return "blue";
  if (priceUsd < 200) return "green";
  if (priceUsd < 600) return "purple";
  if (priceUsd < 1800) return "red";
  return "gold";
}
