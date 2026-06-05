/**
 * grant-format.ts — PRESENTATIONAL descriptors for a signup grant rule.
 *
 * These are NOT engine math (no economics live here — that's `engine.ts`).
 * They turn a `GrantRule` discriminated union into a short human label and an
 * operational-complexity rank for the comparison table / panels. Kept dep-free
 * and co-located with the engine so the config can bind them, mirroring the
 * deposit-bonus `forecast-format.ts`.
 */

import type { GrantRule } from "./types";

/** Short "grant logic" label, e.g. "$5 flat" or "Per-segment + $5 gate". */
export function grantLogicLabel(grant: GrantRule): string {
  switch (grant.kind) {
    case "flat_grant":
      return `$${fmt(grant.grantUsd)} flat (ungated)`;
    case "deposit_gated":
      return `$${fmt(grant.grantUsd)} · $${fmt(grant.minDepositUsd)} deposit gate`;
    case "tiered_levelup":
      return `$${fmt(grant.instantGrantUsd)} + ${fmt(grant.levelTranches)}×$${fmt(grant.trancheUsd)} level-ups`;
    case "dynamic_segment":
      return grant.minDepositUsd > 0
        ? `Per-segment + $${fmt(grant.minDepositUsd)} gate`
        : `Per-segment (ungated)`;
  }
}

/**
 * Operational complexity rank (1 = simplest to ship / explain, 3 = most moving
 * parts). A flat ungated grant is trivial; a deposit gate or a tiered ladder
 * adds a moving part; a per-segment dynamic policy (especially gated) is the
 * hardest to operate.
 */
export function grantComplexity(grant: GrantRule): 1 | 2 | 3 {
  switch (grant.kind) {
    case "flat_grant":
      return 1;
    case "deposit_gated":
      return 2;
    case "tiered_levelup":
      return 2;
    case "dynamic_segment":
      return 3;
  }
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
