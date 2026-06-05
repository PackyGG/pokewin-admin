/**
 * forecast-format.ts — PRESENTATIONAL descriptors for a MOTHA giveaway scenario.
 *
 * These are NOT engine math (no economics live here — that's `_forecast/`).
 * They turn a scenario's per-channel spend multipliers into a short human
 * "policy logic" label and an operational-complexity rank for the comparison
 * table / panels. Kept out of the engine so the engine stays framework- and
 * copy-agnostic, and out of the components so two surfaces describe a scenario
 * identically. (Mirrors the deposit-bonus `forecast-format.ts` role.)
 */

import { CHANNELS } from "../_forecast";
import type { MothaChannel, ScenarioConfig } from "../_forecast";

/** Short channel label by id (e.g. "tips" → "Tips"). */
function channelShort(id: MothaChannel): string {
  switch (id) {
    case "tips":
      return "Tips";
    case "rain":
      return "Rain";
    case "sponsorship":
      return "Sponsored";
  }
}

/** Format a retention multiplier as a signed trim, e.g. 0.7 → "−30%", 1 → "100%". */
function trimLabel(mult: number): string {
  const pct = Math.round((1 - mult) * 100);
  if (pct === 0) return "0%";
  if (mult <= 0) return "cut";
  return `−${pct}%`;
}

/**
 * Short "policy logic" label summarizing a scenario's per-channel trims, e.g.
 * "All unchanged", "All −30%", or "Tips −50% · Rain cut".
 */
export function channelLogicLabel(scenario: ScenarioConfig): string {
  const m = scenario.channelMultiplier;
  const vals = CHANNELS.map((c) => m[c.id]);
  const allEqual = vals.every((v) => Math.abs(v - vals[0]) < 1e-9);

  if (allEqual) {
    if (Math.abs(vals[0] - 1) < 1e-9) return "All unchanged";
    if (vals[0] <= 0) return "All cut";
    return `All ${trimLabel(vals[0])}`;
  }

  // Mixed: list only the channels that are trimmed from baseline (mult < 1).
  const trimmed = CHANNELS.filter((c) => m[c.id] < 1 - 1e-9);
  if (trimmed.length === 0) return "All unchanged";
  return trimmed.map((c) => `${channelShort(c.id)} ${trimLabel(m[c.id])}`).join(" · ");
}

/**
 * Operational complexity rank (1 = simplest to ship / explain, 3 = most moving
 * parts). A single uniform multiplier across all channels is trivial; trimming
 * one channel is simple; an asymmetric per-channel mix is the hardest to
 * operate / communicate.
 */
export function operationalComplexity(scenario: ScenarioConfig): 1 | 2 | 3 {
  const m = scenario.channelMultiplier;
  const vals = CHANNELS.map((c) => m[c.id]);
  const allEqual = vals.every((v) => Math.abs(v - vals[0]) < 1e-9);
  if (allEqual) return 1; // uniform (incl. baseline)

  const trimmedCount = vals.filter((v) => v < 1 - 1e-9).length;
  // Exactly one channel touched → simple single-channel trim; otherwise an
  // asymmetric multi-channel mix → most moving parts.
  return trimmedCount <= 1 ? 2 : 3;
}
