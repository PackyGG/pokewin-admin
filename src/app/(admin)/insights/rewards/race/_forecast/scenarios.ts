/**
 * scenarios.ts — the shippable RACE-PRIZE scenario library.
 *
 * Plain serializable `ScenarioConfig` objects (no functions / Decimal / Date),
 * so the UI can hand any of these straight into `simulate()` and round-trip them
 * as JSON. The baseline (`flat_pool`) is the literal current policy — the real
 * prize pool, the real tier curve, the current cadence — so every other scenario
 * is measured against it (savings vs baseline = 0).
 *
 * Families:
 *   A — Current baseline        (the real pool / curve / cadence, the reference)
 *   B — Pool scaling            (0.4× / 0.6× / 0.75× / 1.25× / 1.5× the pool)
 *   C — Tier steepness          (flatter 0.5× / 0.7× ; steeper 1.4× / 1.8×)
 *   D — Race cadence            (0.25× / 0.5× ; 1.5× / 2× the race frequency)
 *   E — Blunt reduction         (10% / 25% / 40% off every prize)
 *
 * `RACE_WHATIF_SET` is the focused comparison row set: the baseline plus a clean
 * pool-scaling gradient (0.5× → 1.5×) so the table shows how cost / leakage /
 * retention move as the pool size sweeps at a fixed curve + cadence.
 */

import type { ScenarioConfig } from "./types";

// ─── A — Current baseline ───────────────────────────────────────────────────

export const SCENARIO_A_BASELINE: ScenarioConfig = {
  id: "A-baseline",
  label: "A · Current baseline",
  description:
    "Current policy: the real prize pool, the real tier curve and the current race cadence. The reference every other scenario is measured against (savings vs baseline = 0).",
  policy: { kind: "flat_pool" },
  schemaVersion: 1,
};

// ─── B — Pool scaling ───────────────────────────────────────────────────────

export const SCENARIO_B_POOL_40: ScenarioConfig = {
  id: "B-pool-040",
  label: "B · 0.40× pool",
  description:
    "Shrink every prize pool to 40% of today, same tier curve + cadence. The leanest pool in the library — biggest cost cut, sharpest engagement risk.",
  policy: { kind: "scaled_pool", poolScale: 0.4 },
  schemaVersion: 1,
};

export const SCENARIO_B_POOL_60: ScenarioConfig = {
  id: "B-pool-060",
  label: "B · 0.60× pool",
  description:
    "Pools at 60% of today, same curve + cadence. A material trim that still keeps a meaningful prize for the field.",
  policy: { kind: "scaled_pool", poolScale: 0.6 },
  schemaVersion: 1,
};

export const SCENARIO_B_POOL_75: ScenarioConfig = {
  id: "B-pool-075",
  label: "B · 0.75× pool",
  description:
    "Pools at 75% of today, same curve + cadence. A modest cost cut with a small hit to the competitive incentive.",
  policy: { kind: "scaled_pool", poolScale: 0.75 },
  schemaVersion: 1,
};

export const SCENARIO_B_POOL_125: ScenarioConfig = {
  id: "B-pool-125",
  label: "B · 1.25× pool",
  description:
    "Richer pools at 125% of today, same curve + cadence. More reward for the field — costs more, lifts engagement, raises cannibalization risk.",
  policy: { kind: "scaled_pool", poolScale: 1.25 },
  schemaVersion: 1,
};

export const SCENARIO_B_POOL_150: ScenarioConfig = {
  id: "B-pool-150",
  label: "B · 1.50× pool",
  description:
    "Pools at 150% of today, same curve + cadence. The richest pool in the library — maximum engagement pull, highest spend + cannibalization.",
  policy: { kind: "scaled_pool", poolScale: 1.5 },
  schemaVersion: 1,
};

// ─── C — Tier steepness (pool-neutral redistribution) ────────────────────────

export const SCENARIO_C_FLAT_05: ScenarioConfig = {
  id: "C-steep-050",
  label: "C · Flatter curve (0.5×)",
  description:
    "Same total pool, flattened toward the tail (steepness 0.5×). Spreads prizes across more finishers — broader engagement, but more spend leaks to churned tail winners.",
  policy: { kind: "steepness", steepness: 0.5 },
  schemaVersion: 1,
};

export const SCENARIO_C_FLAT_07: ScenarioConfig = {
  id: "C-steep-070",
  label: "C · Flatter curve (0.7×)",
  description:
    "Same total pool, mildly flattened (steepness 0.7×). A gentler spread toward mid/tail finishers than the 0.5× variant.",
  policy: { kind: "steepness", steepness: 0.7 },
  schemaVersion: 1,
};

export const SCENARIO_C_STEEP_14: ScenarioConfig = {
  id: "C-steep-140",
  label: "C · Steeper curve (1.4×)",
  description:
    "Same total pool, more top-heavy (steepness 1.4×). Concentrates spend on the champion + podium — starves the tail, cutting dead-weight leakage at some cost to broad engagement.",
  policy: { kind: "steepness", steepness: 1.4 },
  schemaVersion: 1,
};

export const SCENARIO_C_STEEP_18: ScenarioConfig = {
  id: "C-steep-180",
  label: "C · Steeper curve (1.8×)",
  description:
    "Same total pool, sharply top-heavy (steepness 1.8×). Winner-takes-most — the strongest leakage capture in the curve family, the highest tail-starvation friction.",
  policy: { kind: "steepness", steepness: 1.8 },
  schemaVersion: 1,
};

// ─── D — Race cadence ─────────────────────────────────────────────────────────

export const SCENARIO_D_CADENCE_025: ScenarioConfig = {
  id: "D-cadence-025",
  label: "D · 0.25× cadence",
  description:
    "Run races a quarter as often, same per-race pool + curve. Total spend drops to 25% — the cheapest cadence, but races become rare events (lumpy payout, lower regular engagement).",
  policy: { kind: "cadence", cadenceMult: 0.25 },
  schemaVersion: 1,
};

export const SCENARIO_D_CADENCE_050: ScenarioConfig = {
  id: "D-cadence-050",
  label: "D · 0.50× cadence",
  description:
    "Run races half as often, same per-race pool + curve. Total spend halves; races stay reasonably regular.",
  policy: { kind: "cadence", cadenceMult: 0.5 },
  schemaVersion: 1,
};

export const SCENARIO_D_CADENCE_150: ScenarioConfig = {
  id: "D-cadence-150",
  label: "D · 1.50× cadence",
  description:
    "Run races 50% more often, same per-race pool + curve. More chances to compete — total spend rises 50%, grind pressure climbs.",
  policy: { kind: "cadence", cadenceMult: 1.5 },
  schemaVersion: 1,
};

export const SCENARIO_D_CADENCE_200: ScenarioConfig = {
  id: "D-cadence-200",
  label: "D · 2.00× cadence",
  description:
    "Double the race frequency, same per-race pool + curve. The most races in the library — maximum engagement cadence, double the spend, highest grind friction.",
  policy: { kind: "cadence", cadenceMult: 2 },
  schemaVersion: 1,
};

// ─── E — Blunt reduction ──────────────────────────────────────────────────────

export const SCENARIO_E_REDUCE_10: ScenarioConfig = {
  id: "E-reduce-10",
  label: "E · −10% all prizes",
  description:
    "A blunt 10% off every prize, same curve + cadence. The simplest possible cost cut — uniform, easy to ship, barely touches the curve shape.",
  policy: { kind: "reduction", reductionPct: 0.1 },
  schemaVersion: 1,
};

export const SCENARIO_E_REDUCE_25: ScenarioConfig = {
  id: "E-reduce-25",
  label: "E · −25% all prizes",
  description:
    "A blunt 25% off every prize, same curve + cadence. A meaningful uniform trim with a moderate hit to the field's reward.",
  policy: { kind: "reduction", reductionPct: 0.25 },
  schemaVersion: 1,
};

export const SCENARIO_E_REDUCE_40: ScenarioConfig = {
  id: "E-reduce-40",
  label: "E · −40% all prizes",
  description:
    "A blunt 40% off every prize, same curve + cadence. The deepest uniform cut — large savings, the steepest engagement risk among the reduction variants.",
  policy: { kind: "reduction", reductionPct: 0.4 },
  schemaVersion: 1,
};

// ─── Library aggregate ────────────────────────────────────────────────────────

/** The full shippable scenario library (A–E), baseline first. */
export const SCENARIO_LIBRARY: ScenarioConfig[] = [
  // A — baseline (always row 0)
  SCENARIO_A_BASELINE,
  // B — pool scaling (0.40 → 1.50)
  SCENARIO_B_POOL_40,
  SCENARIO_B_POOL_60,
  SCENARIO_B_POOL_75,
  SCENARIO_B_POOL_125,
  SCENARIO_B_POOL_150,
  // C — tier steepness (flatter → steeper)
  SCENARIO_C_FLAT_05,
  SCENARIO_C_FLAT_07,
  SCENARIO_C_STEEP_14,
  SCENARIO_C_STEEP_18,
  // D — race cadence (sparse → frequent)
  SCENARIO_D_CADENCE_025,
  SCENARIO_D_CADENCE_050,
  SCENARIO_D_CADENCE_150,
  SCENARIO_D_CADENCE_200,
  // E — blunt reduction
  SCENARIO_E_REDUCE_10,
  SCENARIO_E_REDUCE_25,
  SCENARIO_E_REDUCE_40,
];

// ─── Race what-if set (the comparison-table rows) ─────────────────────────────

const WHATIF_POOL_50: ScenarioConfig = {
  id: "whatif-pool-050",
  label: "0.50× pool",
  description: "Pools at 50% of today, same curve + cadence.",
  policy: { kind: "scaled_pool", poolScale: 0.5 },
  schemaVersion: 1,
};

const WHATIF_POOL_70: ScenarioConfig = {
  id: "whatif-pool-070",
  label: "0.70× pool",
  description: "Pools at 70% of today, same curve + cadence.",
  policy: { kind: "scaled_pool", poolScale: 0.7 },
  schemaVersion: 1,
};

const WHATIF_POOL_90: ScenarioConfig = {
  id: "whatif-pool-090",
  label: "0.90× pool",
  description: "Pools at 90% of today, same curve + cadence.",
  policy: { kind: "scaled_pool", poolScale: 0.9 },
  schemaVersion: 1,
};

const WHATIF_POOL_110: ScenarioConfig = {
  id: "whatif-pool-110",
  label: "1.10× pool",
  description: "Pools at 110% of today, same curve + cadence.",
  policy: { kind: "scaled_pool", poolScale: 1.1 },
  schemaVersion: 1,
};

const WHATIF_POOL_130: ScenarioConfig = {
  id: "whatif-pool-130",
  label: "1.30× pool",
  description: "Pools at 130% of today, same curve + cadence.",
  policy: { kind: "scaled_pool", poolScale: 1.3 },
  schemaVersion: 1,
};

const WHATIF_POOL_150: ScenarioConfig = {
  id: "whatif-pool-150",
  label: "1.50× pool",
  description: "Pools at 150% of today, same curve + cadence.",
  policy: { kind: "scaled_pool", poolScale: 1.5 },
  schemaVersion: 1,
};

/**
 * Explicit pool-scaling comparison set. Row 0 is the baseline so the table's
 * savings columns are populated relative to the current policy. The remaining
 * rows form a clean pool-size gradient (0.5× → 1.5×) so the table shows how
 * cost / leakage / retention move as the pool sweeps at a fixed curve + cadence.
 */
export const RACE_WHATIF_SET: ScenarioConfig[] = [
  SCENARIO_A_BASELINE,
  WHATIF_POOL_50,
  WHATIF_POOL_70,
  WHATIF_POOL_90,
  WHATIF_POOL_110,
  WHATIF_POOL_130,
  WHATIF_POOL_150,
];

/** The id of the reference (baseline) scenario shared by both sets. */
export const BASELINE_SCENARIO_ID = SCENARIO_A_BASELINE.id;
