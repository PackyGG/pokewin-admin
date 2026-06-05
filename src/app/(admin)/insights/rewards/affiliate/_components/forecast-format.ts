/**
 * forecast-format.ts — PRESENTATIONAL descriptors for an affiliate commission
 * policy.
 *
 * These are NOT engine math (no economics live here — that's `_forecast/`).
 * They turn a `RatePolicy` discriminated union into a short human label and an
 * operational-complexity rank for the comparison table / panels. Kept out of the
 * engine so the engine stays framework- and copy-agnostic, and out of the
 * components so two surfaces describe a policy identically. Mirrors the
 * deposit-bonus reference (`deposit-bonus/_components/forecast-format.ts`).
 */

import type { RatePolicy } from "../_forecast";

/** Short "policy logic" label, e.g. "−20% flat" or "Bar ×2 + −15%". */
export function policyLogicLabel(policy: RatePolicy): string {
  switch (policy.kind) {
    case "current":
      return "Current rates";
    case "flat_trim":
      return `${pct(policy.rateMult)} flat`;
    case "per_tier":
      return "Per-tier rebalance";
    case "qualification": {
      const bar = `Bar ×${fmt(policy.thresholdMult)}`;
      return policy.rateMult === 1 ? bar : `${bar} + ${pct(policy.rateMult)}`;
    }
    case "hybrid":
      return `Per-tier + bar ×${fmt(policy.thresholdMult)} + screen`;
  }
}

/**
 * Operational complexity rank (1 = simplest to ship / explain, 3 = most moving
 * parts). A flat trim is trivial; a per-tier rebalance or a threshold tighten is
 * moderate; the hybrid (per-tier rates + threshold + quality screen) is hardest.
 */
export function operationalComplexity(policy: RatePolicy): 1 | 2 | 3 {
  switch (policy.kind) {
    case "current":
    case "flat_trim":
      return 1;
    case "per_tier":
    case "qualification":
      return 2;
    case "hybrid":
      return 3;
  }
}

/** Render a rate multiplier as a signed percentage delta, e.g. 0.8 → "−20%". */
function pct(mult: number): string {
  const delta = Math.round((mult - 1) * 100);
  if (delta === 0) return "0%";
  return delta > 0 ? `+${delta}%` : `${delta}%`;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
