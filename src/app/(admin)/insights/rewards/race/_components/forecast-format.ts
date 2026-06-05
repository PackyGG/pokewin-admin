/**
 * forecast-format.ts — PRESENTATIONAL descriptors for a race policy.
 *
 * These are NOT engine math (no economics live here — that's `_forecast/`). They
 * turn a `RacePolicy` discriminated union into a short human label and an
 * operational-complexity rank for the comparison table / panels. Kept out of the
 * engine so the engine stays framework- and copy-agnostic, and out of the
 * components so two surfaces describe a policy identically. Mirrors the
 * deposit-bonus reference (`deposit-bonus/_components/forecast-format.ts`).
 */

import type { RacePolicy } from "../_forecast";

/** Short "policy logic" label, e.g. "Pool 0.6×" or "Steepness 1.4×". */
export function policyLogicLabel(policy: RacePolicy): string {
  switch (policy.kind) {
    case "flat_pool":
      return "Current pool / curve / cadence";
    case "scaled_pool":
      return `Pool ${fmtMult(policy.poolScale)} (same curve)`;
    case "steepness":
      return `Steepness ${fmtMult(policy.steepness)} (pool-neutral)`;
    case "cadence":
      return `Cadence ${fmtMult(policy.cadenceMult)} (same pool)`;
    case "reduction":
      return `−${fmtPct(policy.reductionPct)} all prizes`;
  }
}

/**
 * Operational complexity rank (1 = simplest to ship / explain, 3 = most moving
 * parts). A blunt across-the-board reduction or a flat pool scale is trivial;
 * reshaping the tier curve or changing cadence touches more of the race config,
 * so it ranks higher.
 */
export function operationalComplexity(policy: RacePolicy): 1 | 2 | 3 {
  switch (policy.kind) {
    case "flat_pool":
      return 1;
    case "reduction":
      return 1;
    case "scaled_pool":
      return 2;
    case "cadence":
      return 2;
    case "steepness":
      return 3;
  }
}

function fmtMult(n: number): string {
  return `${Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, "")}×`;
}

function fmtPct(n: number): string {
  return `${Math.round(n * 100)}%`;
}
