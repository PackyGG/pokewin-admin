/**
 * forecast-format.ts — PRESENTATIONAL descriptors for a rakeback rate policy.
 *
 * These are NOT engine math (no economics live here — that's `_forecast/`).
 * They turn a `RatePolicy` discriminated union into a short human label and an
 * operational-complexity rank for the comparison table / panels. Kept out of
 * the engine so the engine stays framework- and copy-agnostic, and out of the
 * components so two surfaces describe a policy identically. Mirrors the
 * deposit-bonus `_components/forecast-format.ts`.
 */

import type { RatePolicy } from "../_forecast";

/** Short "policy logic" label, e.g. "5% / daily" or "Tiered + taper". */
export function rateLogicLabel(policy: RatePolicy): string {
  switch (policy.kind) {
    case "flat_rate":
      return `${pct(policy.rate)} / ${policy.cadence} (flat)`;
    case "cadence_gated":
      return `${pct(policy.rate)} / ${policy.cadence}`;
    case "expiry_capped":
      return `${pct(policy.rate)} / ${policy.cadence} · ${fmt(policy.expiryDays)}d expiry`;
    case "tiered_by_wager":
      return `Per-tier / ${policy.cadence}`;
    case "progressive_taper":
      return `${pct(policy.baseRate)} → ${pct(policy.floorRate)} taper`;
  }
}

/**
 * Operational complexity rank (1 = simplest to ship / explain, 3 = most moving
 * parts). A flat rate is trivial; a per-tier or progressive-taper policy with a
 * non-daily cadence is the hardest to operate.
 */
export function operationalComplexity(policy: RatePolicy): 1 | 2 | 3 {
  switch (policy.kind) {
    case "flat_rate":
      return 1;
    case "cadence_gated":
    case "expiry_capped":
      return 2;
    case "tiered_by_wager":
    case "progressive_taper":
      return 3;
  }
}

/** Format a 0-1 rate fraction as a percent-of-wager string, e.g. 0.035 → "3.5%". */
function pct(rate: number): string {
  const v = rate * 100;
  return `${Number.isInteger(v) ? String(v) : v.toFixed(1)}%`;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
