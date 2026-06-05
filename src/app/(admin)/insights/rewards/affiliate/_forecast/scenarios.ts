/**
 * scenarios.ts — the shippable AFFILIATE commission scenario library.
 *
 * Plain serializable `ScenarioConfig` objects (no functions / Decimal / Date),
 * so the UI can hand any of these straight into `simulate()` and round-trip them
 * as JSON. Scenario A is the literal current policy (`{ kind: "current" }`) so
 * its savings-vs-baseline is 0 by construction.
 *
 * Families:
 *   A — Current policy           (the reference)
 *   B — Flat trims               (−10% / −20% / −30% / −40% across the board)
 *   C — Per-tier rebalances      (squeeze whales / protect the funnel / trim tail)
 *   D — Qualification tightening (raise the bar 1.5× / 2× / 3×, ± a rate trim)
 *   E — Hybrid policies          (the balanced lever + a strict variant)
 *
 * `AFFILIATE_WHATIF_SET` is the focused comparison row set: the current policy
 * plus a clean flat-trim gradient (−10 → −40%) so the table shows how the
 * commission bill, leakage and friction move as rates come down uniformly.
 */

import type { ScenarioConfig, TierId } from "./types";

// A neutral per-tier multiplier map (all 1×) to clone-and-tweak from.
const NEUTRAL_TIER_MULT: Record<TierId, number> = {
  whale: 1,
  established: 1,
  emerging: 1,
  micro: 1,
  dormant: 1,
};

// ─── A — Current policy ───────────────────────────────────────────────────────

export const SCENARIO_A_CURRENT: ScenarioConfig = {
  id: "A-current",
  label: "A · Current policy",
  description:
    "The live commission ladder + current qualification thresholds. The reference every other scenario is measured against (savings vs baseline = 0).",
  policy: { kind: "current" },
  schemaVersion: 1,
};

// ─── B — Flat trims ───────────────────────────────────────────────────────────

export const SCENARIO_B_TRIM_10: ScenarioConfig = {
  id: "B-trim-10",
  label: "B · −10% flat",
  description:
    "Every tier's commission rate cut 10% across the board. The gentlest trim — shaves the bill proportionally with minimal partner-relations friction.",
  policy: { kind: "flat_trim", rateMult: 0.9 },
  schemaVersion: 1,
};

export const SCENARIO_B_TRIM_20: ScenarioConfig = {
  id: "B-trim-20",
  label: "B · −20% flat",
  description:
    "Every tier's commission rate cut 20% across the board. A moderate uniform trim — meaningful savings, moderate friction.",
  policy: { kind: "flat_trim", rateMult: 0.8 },
  schemaVersion: 1,
};

export const SCENARIO_B_TRIM_30: ScenarioConfig = {
  id: "B-trim-30",
  label: "B · −30% flat",
  description:
    "Every tier's commission rate cut 30% across the board. An aggressive uniform trim — large savings, higher risk of partner churn.",
  policy: { kind: "flat_trim", rateMult: 0.7 },
  schemaVersion: 1,
};

export const SCENARIO_B_TRIM_40: ScenarioConfig = {
  id: "B-trim-40",
  label: "B · −40% flat",
  description:
    "Every tier's commission rate cut 40% across the board. The deepest flat trim in the library — maximum savings, maximum partner friction.",
  policy: { kind: "flat_trim", rateMult: 0.6 },
  schemaVersion: 1,
};

// ─── C — Per-tier rebalances ──────────────────────────────────────────────────

export const SCENARIO_C_SQUEEZE_WHALES: ScenarioConfig = {
  id: "C-squeeze-whales",
  label: "C · Squeeze whales",
  description:
    "Cut the richest tiers hard (whale −30%, established −20%) while leaving emerging/micro untouched and the dormant tail trimmed. Targets the bulk of the bill where the affiliates are least price-sensitive, protecting the acquisition funnel.",
  policy: {
    kind: "per_tier",
    perTierRateMult: { ...NEUTRAL_TIER_MULT, whale: 0.7, established: 0.8, dormant: 0.8 },
  },
  schemaVersion: 1,
};

export const SCENARIO_C_PROTECT_FUNNEL: ScenarioConfig = {
  id: "C-protect-funnel",
  label: "C · Protect funnel",
  description:
    "Keep emerging/micro rates full (protect new-affiliate acquisition) but trim the established/whale tiers modestly (−15% each) and cut the dormant tail (−40%). A growth-friendly rebalance.",
  policy: {
    kind: "per_tier",
    perTierRateMult: { ...NEUTRAL_TIER_MULT, whale: 0.85, established: 0.85, dormant: 0.6 },
  },
  schemaVersion: 1,
};

export const SCENARIO_C_TRIM_TAIL: ScenarioConfig = {
  id: "C-trim-tail",
  label: "C · Trim the tail",
  description:
    "Leave whale/established rates intact, trim emerging (−15%) and cut micro/dormant hard (−40% / −60%). Squeezes the low-ROI long tail while keeping top partners whole.",
  policy: {
    kind: "per_tier",
    perTierRateMult: { ...NEUTRAL_TIER_MULT, emerging: 0.85, micro: 0.6, dormant: 0.4 },
  },
  schemaVersion: 1,
};

// ─── D — Qualification tightening ─────────────────────────────────────────────

export const SCENARIO_D_QUAL_1_5: ScenarioConfig = {
  id: "D-qual-1_5",
  label: "D · Bar ×1.5",
  description:
    "Raise the cumulative-wager qualification bar 1.5×, rates unchanged. The long-tail / dormant affiliates below the new bar stop accruing — kills low-quality commission, at the cost of some marginal acquisition.",
  policy: { kind: "qualification", thresholdMult: 1.5, rateMult: 1 },
  schemaVersion: 1,
};

export const SCENARIO_D_QUAL_2: ScenarioConfig = {
  id: "D-qual-2",
  label: "D · Bar ×2",
  description:
    "Double the qualification bar, rates unchanged. A stronger gate on the low-quality tail — more leakage captured, more marginal referral volume given up.",
  policy: { kind: "qualification", thresholdMult: 2, rateMult: 1 },
  schemaVersion: 1,
};

export const SCENARIO_D_QUAL_3: ScenarioConfig = {
  id: "D-qual-3",
  label: "D · Bar ×3",
  description:
    "Triple the qualification bar — only established/whale-scale affiliates qualify. Maximum leakage capture from the tail, the largest acquisition trade-off.",
  policy: { kind: "qualification", thresholdMult: 3, rateMult: 1 },
  schemaVersion: 1,
};

export const SCENARIO_D_QUAL_2_TRIM: ScenarioConfig = {
  id: "D-qual-2-trim",
  label: "D · Bar ×2 + −15%",
  description:
    "Double the qualification bar AND trim every rate 15%. Stacks a tighter gate on top of a uniform rate cut — squeezes both the tail and the bill, with compounding partner friction.",
  policy: { kind: "qualification", thresholdMult: 2, rateMult: 0.85 },
  schemaVersion: 1,
};

// ─── E — Hybrid policies ──────────────────────────────────────────────────────

export const SCENARIO_E_HYBRID: ScenarioConfig = {
  id: "E-hybrid",
  label: "E · Hybrid (balanced)",
  description:
    "Per-tier trims (whale −20% / established −10%, emerging & micro kept) + a 1.5× qualification bar + a 30% low-quality referral screen. The balanced policy: squeeze the top, gate the tail, screen junk traffic, protect new-affiliate growth.",
  policy: {
    kind: "hybrid",
    perTierRateMult: { ...NEUTRAL_TIER_MULT, whale: 0.8, established: 0.9 },
    thresholdMult: 1.5,
    qualityScreen: 0.3,
  },
  schemaVersion: 1,
};

export const SCENARIO_E_HYBRID_STRICT: ScenarioConfig = {
  id: "E-hybrid-strict",
  label: "E · Hybrid (strict)",
  description:
    "Strict variant of the hybrid: deeper per-tier trims (whale −30% / established −20% / emerging −10%), a 2× qualification bar, and a 50% low-quality screen. Squeezes leakage and the bill hardest at the most partner-relations risk.",
  policy: {
    kind: "hybrid",
    perTierRateMult: { ...NEUTRAL_TIER_MULT, whale: 0.7, established: 0.8, emerging: 0.9 },
    thresholdMult: 2,
    qualityScreen: 0.5,
  },
  schemaVersion: 1,
};

// ─── Library aggregate ────────────────────────────────────────────────────────

/** The full shippable scenario library (A–E), baseline first. */
export const SCENARIO_LIBRARY: ScenarioConfig[] = [
  // A — current (always row 0)
  SCENARIO_A_CURRENT,
  // B — flat trims (−10 → −40%)
  SCENARIO_B_TRIM_10,
  SCENARIO_B_TRIM_20,
  SCENARIO_B_TRIM_30,
  SCENARIO_B_TRIM_40,
  // C — per-tier rebalances
  SCENARIO_C_SQUEEZE_WHALES,
  SCENARIO_C_PROTECT_FUNNEL,
  SCENARIO_C_TRIM_TAIL,
  // D — qualification tightening
  SCENARIO_D_QUAL_1_5,
  SCENARIO_D_QUAL_2,
  SCENARIO_D_QUAL_3,
  SCENARIO_D_QUAL_2_TRIM,
  // E — hybrid policies
  SCENARIO_E_HYBRID,
  SCENARIO_E_HYBRID_STRICT,
];

// ─── What-if set (the comparison-table rows) ──────────────────────────────────

/**
 * Explicit flat-trim comparison set. Row 0 is the current policy so the table's
 * savings columns populate relative to it. The trim rows form a clean −10 → −40%
 * gradient so the table shows how cost / leakage / friction move as rates come
 * down uniformly — the cleanest single-axis sweep for a side-by-side read.
 */
export const AFFILIATE_WHATIF_SET: ScenarioConfig[] = [
  SCENARIO_A_CURRENT,
  SCENARIO_B_TRIM_10,
  SCENARIO_B_TRIM_20,
  SCENARIO_B_TRIM_30,
  SCENARIO_B_TRIM_40,
];

/** The id of the reference (baseline) scenario shared by both sets. */
export const BASELINE_SCENARIO_ID = SCENARIO_A_CURRENT.id;
