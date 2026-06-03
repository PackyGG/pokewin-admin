/**
 * forecast-format.ts — PRESENTATIONAL descriptors for a cap rule.
 *
 * These are NOT engine math (no economics live here — that's `_forecast/`).
 * They turn a `CapRule` discriminated union into a short human label and an
 * operational-complexity rank for the comparison table / panels. Kept out of
 * the engine so the engine stays framework- and copy-agnostic, and out of the
 * components so two surfaces describe a cap identically.
 */

import type { CapRule } from "../_forecast";

/** Short "cap logic" label, e.g. "$100 / 24h" or "Per-segment + decay". */
export function capLogicLabel(cap: CapRule): string {
  switch (cap.kind) {
    case "fixed_window":
      return `$${fmt(cap.capUsd)} / ${fmt(cap.windowHours)}h (flat)`;
    case "split_window":
      return `$${fmt(cap.capUsd)} / ${fmt(cap.windowHours)}h (spaced)`;
    case "weekly_pooled":
      return `$${fmt(cap.capUsd)} / week (pooled)`;
    case "progressive_decay":
      return `$${fmt(cap.baseCapUsd)} → $${fmt(cap.floorCapUsd)} (decay)`;
    case "dynamic_segment":
      return `Per-segment + ${cap.firstDepositOfDayBonusMult}× first-of-day`;
  }
}

/**
 * Operational complexity rank (1 = simplest to ship / explain, 3 = most
 * moving parts). A flat fixed cap is trivial; a per-segment dynamic policy
 * with first-of-day multipliers and decay is the hardest to operate.
 */
export function operationalComplexity(cap: CapRule): 1 | 2 | 3 {
  switch (cap.kind) {
    case "fixed_window":
      return 1;
    case "split_window":
      return 2;
    case "weekly_pooled":
      return 2;
    case "progressive_decay":
      return 2;
    case "dynamic_segment":
      return 3;
  }
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
