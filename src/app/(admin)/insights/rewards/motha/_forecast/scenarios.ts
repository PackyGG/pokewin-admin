/**
 * scenarios.ts — the shippable MOTHA GIVEAWAYS scenario library.
 *
 * Plain serializable `ScenarioConfig` objects (no functions / Decimal / Date),
 * so the UI can hand any of these straight into `simulate()` and round-trip
 * them as JSON. The baseline (Scenario A) keeps every channel multiplier at
 * `BASELINE_MULTIPLIER` (1 = current measured spend) so it stays the literal
 * current policy (savings vs baseline = 0).
 *
 * Each scenario's `channelMultiplier` is the FRACTION of each channel's
 * baseline giveaway that REMAINS (1 = unchanged, 0.7 = trimmed 30%, 0 = cut).
 *
 * Families:
 *   A — Current spend                  (every channel × 1.0 — the reference)
 *   B — Trim CREATOR TIPS              (−25% / −50% / −75% / cut)
 *   C — Trim RAIN TIPS                 (−25% / −50% / −75% / cut)
 *   D — Trim SPONSORED BATTLES         (−25% / −50% / −75% / cut)
 *   E — Combined trims                 (light −15% all / moderate −30% all /
 *                                       deep −50% all / tips+rain focus /
 *                                       sponsorship-only cut / austerity)
 *
 * `MOTHA_WHATIF_SET` is the focused "all-channel haircut" comparison row set:
 *  baseline plus a clean uniform-trim gradient (−10% → −90%) so the table shows
 *  how cost / waste / community-impact move as the overall budget tightens.
 */

import { BASELINE_MULTIPLIER } from "./constants";
import type { MothaChannel, ScenarioConfig } from "./types";

/** Build a `channelMultiplier` record from explicit per-channel fractions. */
function mult(
  tips: number,
  rain: number,
  sponsorship: number,
): Record<MothaChannel, number> {
  return { tips, rain, sponsorship };
}

// ─── A — Current spend ────────────────────────────────────────────────────

export const SCENARIO_A_BASELINE: ScenarioConfig = {
  id: "A-baseline",
  label: "A · Current spend",
  description:
    "Current giveaway budget across all three channels (creator tips, rain tips, sponsored battles) — unchanged. The reference every trim is measured against (savings vs baseline = 0).",
  channelMultiplier: mult(BASELINE_MULTIPLIER, BASELINE_MULTIPLIER, BASELINE_MULTIPLIER),
  schemaVersion: 1,
};

// ─── B — Trim creator tips ────────────────────────────────────────────────

export const SCENARIO_B_TIPS_25: ScenarioConfig = {
  id: "B-tips-25",
  label: "B · Tips −25%",
  description: "Trim creator tips 25%; rain + sponsored battles unchanged. The gentlest tip pullback.",
  channelMultiplier: mult(0.75, 1, 1),
  schemaVersion: 1,
};

export const SCENARIO_B_TIPS_50: ScenarioConfig = {
  id: "B-tips-50",
  label: "B · Tips −50%",
  description: "Halve creator tips; rain + sponsored battles unchanged. A material tip cut while preserving the other channels.",
  channelMultiplier: mult(0.5, 1, 1),
  schemaVersion: 1,
};

export const SCENARIO_B_TIPS_75: ScenarioConfig = {
  id: "B-tips-75",
  label: "B · Tips −75%",
  description: "Cut creator tips to a quarter; rain + sponsored battles unchanged. Tips become a token gesture.",
  channelMultiplier: mult(0.25, 1, 1),
  schemaVersion: 1,
};

export const SCENARIO_B_TIPS_CUT: ScenarioConfig = {
  id: "B-tips-cut",
  label: "B · Tips cut",
  description: "Stop creator tips entirely; rain + sponsored battles unchanged. Isolates the full cost of the tip channel.",
  channelMultiplier: mult(0, 1, 1),
  schemaVersion: 1,
};

// ─── C — Trim rain tips ───────────────────────────────────────────────────

export const SCENARIO_C_RAIN_25: ScenarioConfig = {
  id: "C-rain-25",
  label: "C · Rain −25%",
  description: "Trim rain-pool tips 25%; tips + sponsored battles unchanged. The gentlest rain pullback.",
  channelMultiplier: mult(1, 0.75, 1),
  schemaVersion: 1,
};

export const SCENARIO_C_RAIN_50: ScenarioConfig = {
  id: "C-rain-50",
  label: "C · Rain −50%",
  description: "Halve rain-pool tips; tips + sponsored battles unchanged. A material rain cut while preserving the other channels.",
  channelMultiplier: mult(1, 0.5, 1),
  schemaVersion: 1,
};

export const SCENARIO_C_RAIN_75: ScenarioConfig = {
  id: "C-rain-75",
  label: "C · Rain −75%",
  description: "Cut rain-pool tips to a quarter; tips + sponsored battles unchanged. Rain becomes a token contribution.",
  channelMultiplier: mult(1, 0.25, 1),
  schemaVersion: 1,
};

export const SCENARIO_C_RAIN_CUT: ScenarioConfig = {
  id: "C-rain-cut",
  label: "C · Rain cut",
  description: "Stop rain-pool tips entirely; tips + sponsored battles unchanged. Isolates the full cost of the rain channel.",
  channelMultiplier: mult(1, 0, 1),
  schemaVersion: 1,
};

// ─── D — Trim sponsored battles ───────────────────────────────────────────

export const SCENARIO_D_SPONSOR_25: ScenarioConfig = {
  id: "D-sponsor-25",
  label: "D · Sponsored −25%",
  description: "Trim sponsored-battle funding 25%; tips + rain unchanged. The gentlest sponsorship pullback.",
  channelMultiplier: mult(1, 1, 0.75),
  schemaVersion: 1,
};

export const SCENARIO_D_SPONSOR_50: ScenarioConfig = {
  id: "D-sponsor-50",
  label: "D · Sponsored −50%",
  description: "Halve sponsored-battle funding; tips + rain unchanged. A material sponsorship cut while preserving the other channels.",
  channelMultiplier: mult(1, 1, 0.5),
  schemaVersion: 1,
};

export const SCENARIO_D_SPONSOR_75: ScenarioConfig = {
  id: "D-sponsor-75",
  label: "D · Sponsored −75%",
  description: "Cut sponsored-battle funding to a quarter; tips + rain unchanged. Sponsorship becomes occasional.",
  channelMultiplier: mult(1, 1, 0.25),
  schemaVersion: 1,
};

export const SCENARIO_D_SPONSOR_CUT: ScenarioConfig = {
  id: "D-sponsor-cut",
  label: "D · Sponsored cut",
  description: "Stop sponsored-battle funding entirely; tips + rain unchanged. Isolates the full cost of the sponsorship channel.",
  channelMultiplier: mult(1, 1, 0),
  schemaVersion: 1,
};

// ─── E — Combined trims ───────────────────────────────────────────────────

export const SCENARIO_E_ALL_15: ScenarioConfig = {
  id: "E-all-15",
  label: "E · All −15%",
  description: "A light, even 15% haircut across every channel. Spreads a modest budget cut so no single channel is singled out.",
  channelMultiplier: mult(0.85, 0.85, 0.85),
  schemaVersion: 1,
};

export const SCENARIO_E_ALL_30: ScenarioConfig = {
  id: "E-all-30",
  label: "E · All −30%",
  description: "A moderate, even 30% haircut across every channel. A meaningful overall budget reduction kept proportional.",
  channelMultiplier: mult(0.7, 0.7, 0.7),
  schemaVersion: 1,
};

export const SCENARIO_E_ALL_50: ScenarioConfig = {
  id: "E-all-50",
  label: "E · All −50%",
  description: "Halve the entire giveaway budget evenly. An aggressive across-the-board cut while keeping all three channels alive.",
  channelMultiplier: mult(0.5, 0.5, 0.5),
  schemaVersion: 1,
};

export const SCENARIO_E_TIPS_RAIN_FOCUS: ScenarioConfig = {
  id: "E-tips-rain-focus",
  label: "E · Tips+Rain −40%, keep sponsored",
  description: "Trim the two community-broadcast channels (tips −40%, rain −40%) but keep sponsored battles fully funded — concentrates spend on the highest-engagement channel.",
  channelMultiplier: mult(0.6, 0.6, 1),
  schemaVersion: 1,
};

export const SCENARIO_E_KEEP_TIPS: ScenarioConfig = {
  id: "E-keep-tips",
  label: "E · Keep tips, cut rain+sponsored 60%",
  description: "Preserve creator tips in full but cut rain (−60%) and sponsored battles (−60%) — prioritizes the direct creator-relationship channel over the broadcast / battle channels.",
  channelMultiplier: mult(1, 0.4, 0.4),
  schemaVersion: 1,
};

export const SCENARIO_E_AUSTERITY: ScenarioConfig = {
  id: "E-austerity",
  label: "E · Austerity (−80% all)",
  description: "A deep austerity scenario: 80% off every channel. The leanest giveaway budget that still keeps a token presence on all three channels — maximum cash saved, maximum community impact.",
  channelMultiplier: mult(0.2, 0.2, 0.2),
  schemaVersion: 1,
};

// ─── Library aggregate ───────────────────────────────────────────────────

/** The full shippable scenario library (A–E), baseline first. */
export const SCENARIO_LIBRARY: ScenarioConfig[] = [
  // A — current spend (always row 0)
  SCENARIO_A_BASELINE,
  // B — trim creator tips
  SCENARIO_B_TIPS_25,
  SCENARIO_B_TIPS_50,
  SCENARIO_B_TIPS_75,
  SCENARIO_B_TIPS_CUT,
  // C — trim rain tips
  SCENARIO_C_RAIN_25,
  SCENARIO_C_RAIN_50,
  SCENARIO_C_RAIN_75,
  SCENARIO_C_RAIN_CUT,
  // D — trim sponsored battles
  SCENARIO_D_SPONSOR_25,
  SCENARIO_D_SPONSOR_50,
  SCENARIO_D_SPONSOR_75,
  SCENARIO_D_SPONSOR_CUT,
  // E — combined trims
  SCENARIO_E_ALL_15,
  SCENARIO_E_ALL_30,
  SCENARIO_E_ALL_50,
  SCENARIO_E_TIPS_RAIN_FOCUS,
  SCENARIO_E_KEEP_TIPS,
  SCENARIO_E_AUSTERITY,
];

// ─── All-channel haircut what-if set (the comparison-table rows) ────────────

const HAIRCUT_10: ScenarioConfig = {
  id: "haircut-10",
  label: "−10% all",
  description: "Uniform 10% haircut across every channel.",
  channelMultiplier: mult(0.9, 0.9, 0.9),
  schemaVersion: 1,
};

const HAIRCUT_20: ScenarioConfig = {
  id: "haircut-20",
  label: "−20% all",
  description: "Uniform 20% haircut across every channel.",
  channelMultiplier: mult(0.8, 0.8, 0.8),
  schemaVersion: 1,
};

const HAIRCUT_30: ScenarioConfig = {
  id: "haircut-30",
  label: "−30% all",
  description: "Uniform 30% haircut across every channel.",
  channelMultiplier: mult(0.7, 0.7, 0.7),
  schemaVersion: 1,
};

const HAIRCUT_40: ScenarioConfig = {
  id: "haircut-40",
  label: "−40% all",
  description: "Uniform 40% haircut across every channel.",
  channelMultiplier: mult(0.6, 0.6, 0.6),
  schemaVersion: 1,
};

const HAIRCUT_50: ScenarioConfig = {
  id: "haircut-50",
  label: "−50% all",
  description: "Uniform 50% haircut across every channel.",
  channelMultiplier: mult(0.5, 0.5, 0.5),
  schemaVersion: 1,
};

const HAIRCUT_70: ScenarioConfig = {
  id: "haircut-70",
  label: "−70% all",
  description: "Uniform 70% haircut across every channel.",
  channelMultiplier: mult(0.3, 0.3, 0.3),
  schemaVersion: 1,
};

const HAIRCUT_90: ScenarioConfig = {
  id: "haircut-90",
  label: "−90% all",
  description: "Uniform 90% haircut across every channel — a near-total freeze.",
  channelMultiplier: mult(0.1, 0.1, 0.1),
  schemaVersion: 1,
};

/**
 * Explicit "all-channel haircut" comparison set. Row 0 is the baseline so the
 * table's savings columns are populated relative to current spend. The haircut
 * rows form a clean uniform-trim gradient (−10% → −90%) so the table shows how
 * cost / waste / community-impact move as the overall budget tightens.
 */
export const MOTHA_WHATIF_SET: ScenarioConfig[] = [
  SCENARIO_A_BASELINE,
  HAIRCUT_10,
  HAIRCUT_20,
  HAIRCUT_30,
  HAIRCUT_40,
  HAIRCUT_50,
  HAIRCUT_70,
  HAIRCUT_90,
];

/** The id of the reference (baseline) scenario shared by both sets. */
export const BASELINE_SCENARIO_ID = SCENARIO_A_BASELINE.id;
