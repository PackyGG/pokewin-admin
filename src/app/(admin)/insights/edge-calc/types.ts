/**
 * Shared types for /insights/edge-calc — the theoretical edge / EV
 * calculator surface. Four tabs:
 *   • packs     — per-pack theoretical RTP table (pool × prices math)
 *   • upgrader  — per-target-multiplier EV table (empirical buckets
 *                 from upgrader_games + PF metadata)
 *   • scenario  — interactive scenario simulator
 *   • bonus     — bonus stack ROI calculator
 */

export const EDGE_CALC_TABS = ["packs", "upgrader", "scenario", "bonus"] as const;
export type EdgeCalcTab = (typeof EDGE_CALC_TABS)[number];

export function parseEdgeCalcTab(value: string | undefined): EdgeCalcTab {
  if (!value) return "packs";
  return (EDGE_CALC_TABS as readonly string[]).includes(value)
    ? (value as EdgeCalcTab)
    : "packs";
}
