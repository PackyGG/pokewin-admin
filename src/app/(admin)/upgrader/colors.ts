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
