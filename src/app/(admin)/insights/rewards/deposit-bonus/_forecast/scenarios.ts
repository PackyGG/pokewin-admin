/**
 * scenarios.ts — the shippable scenario library.
 *
 * Plain serializable `ScenarioConfig` objects (no functions / Decimal / Date),
 * so the UI can hand any of these straight into `simulate()` and round-trip
 * them as JSON. All caps reference the named baseline (`BASELINE_CAP_USD` /
 * `BASELINE_WINDOW_HOURS`) so Scenario A stays the literal current policy.
 *
 * Families:
 *   A — Current baseline           ($100 / 24h, the reference)
 *   B — Hourly tranches            ($5/hr, $10/hr)
 *   C — 6-hour tranches            ($15/6h, $20/6h)
 *   D — Hybrid dynamic per-segment (the balanced policy)
 *   E — Hard-cap variants          ($50/day, $75/24h, $50/12h, weekly pooled,
 *                                   progressive decay)
 *
 * `SPLIT_CAP_WHATIF_SET` is the explicit comparison row set the audit asked for
 * (100/24h, 10/hr, 5/hr, 20/6h, 15/6h, 50/12h, 75/24h).
 */

import { BASELINE_CAP_USD, BASELINE_WINDOW_HOURS } from "./constants";
import type { ScenarioConfig } from "./types";

// ─── A — Current baseline ───────────────────────────────────────────────────

export const SCENARIO_A_BASELINE: ScenarioConfig = {
  id: "A-baseline",
  label: "A · Current baseline",
  description: `Current policy: $${BASELINE_CAP_USD} per ${BASELINE_WINDOW_HOURS}h window. The reference every other scenario is measured against (savings vs baseline = 0).`,
  cap: { kind: "fixed_window", capUsd: BASELINE_CAP_USD, windowHours: BASELINE_WINDOW_HOURS },
  schemaVersion: 1,
};

// ─── B — Hourly tranches ──────────────────────────────────────────────────────

export const SCENARIO_B_HOURLY_5: ScenarioConfig = {
  id: "B-hourly-5",
  label: "B · $5 / hour",
  description:
    "Hourly tranche: $5 enforced over a rolling 1h window. Maximum pacing — smallest, most frequent caps. Strongly dampens bursty serial claiming.",
  cap: { kind: "split_window", capUsd: 5, windowHours: 1 },
  schemaVersion: 1,
};

export const SCENARIO_B_HOURLY_10: ScenarioConfig = {
  id: "B-hourly-10",
  label: "B · $10 / hour",
  description:
    "Hourly tranche: $10 enforced over a rolling 1h window. Paces payouts while keeping a usable per-claim ceiling.",
  cap: { kind: "split_window", capUsd: 10, windowHours: 1 },
  schemaVersion: 1,
};

// ─── C — 6-hour tranches ──────────────────────────────────────────────────────

export const SCENARIO_C_SIXH_15: ScenarioConfig = {
  id: "C-6h-15",
  label: "C · $15 / 6h",
  description: "6-hour tranche: $15 per rolling 6h window. Moderate pacing, four tranches a day.",
  cap: { kind: "split_window", capUsd: 15, windowHours: 6 },
  schemaVersion: 1,
};

export const SCENARIO_C_SIXH_20: ScenarioConfig = {
  id: "C-6h-20",
  label: "C · $20 / 6h",
  description: "6-hour tranche: $20 per rolling 6h window. Looser tranche, still paced vs a 24h lump.",
  cap: { kind: "split_window", capUsd: 20, windowHours: 6 },
  schemaVersion: 1,
};

// ─── D — Hybrid dynamic per-segment ──────────────────────────────────────────

export const SCENARIO_D_HYBRID: ScenarioConfig = {
  id: "D-hybrid-dynamic",
  label: "D · Hybrid dynamic",
  description:
    "Per-segment caps: generous for low-risk / high-value (preserves retention), strict for high-risk (kills leakage). A 1.25× first-deposit-of-day multiplier rewards genuine re-deposits; caps decay after 3 claims to throttle serial claimers.",
  cap: {
    kind: "dynamic_segment",
    perSegmentCapUsd: {
      legit_low_risk: 150,
      high_value: 200,
      promo_sensitive: 75,
      high_risk_abuse: 25,
      reactivated_dormant: 120,
    },
    windowHours: 24,
    firstDepositOfDayBonusMult: 1.25,
    decayAfterNClaims: 3,
    decayPerClaim: 0.2,
  },
  schemaVersion: 1,
};

// ─── E — Hard-cap variants ────────────────────────────────────────────────────

export const SCENARIO_E_DAILY_50: ScenarioConfig = {
  id: "E-daily-50",
  label: "E · $50 / day",
  description: "Hard daily cap: $50 per 24h window. A simple, much tighter flat ceiling than the baseline.",
  cap: { kind: "split_window", capUsd: 50, windowHours: 24 },
  schemaVersion: 1,
};

export const SCENARIO_E_75_24H: ScenarioConfig = {
  id: "E-75-24h",
  label: "E · $75 / 24h",
  description: "Hard daily cap: $75 per 24h window. A modest trim of the baseline ceiling, same cadence.",
  cap: { kind: "fixed_window", capUsd: 75, windowHours: 24 },
  schemaVersion: 1,
};

export const SCENARIO_E_50_12H: ScenarioConfig = {
  id: "E-50-12h",
  label: "E · $50 / 12h",
  description: "$50 per rolling 12h window — two tranches a day. Caps the dollars AND paces them.",
  cap: { kind: "split_window", capUsd: 50, windowHours: 12 },
  schemaVersion: 1,
};

export const SCENARIO_E_WEEKLY_POOLED: ScenarioConfig = {
  id: "E-weekly-pooled",
  label: "E · $250 / week (pooled)",
  description:
    "A single pooled $250 cap across a rolling 7-day period (≈ $35.71/day amortized). Lets users front-load within a week without a hard daily wall.",
  cap: { kind: "weekly_pooled", capUsd: 250 },
  schemaVersion: 1,
};

export const SCENARIO_E_PROGRESSIVE_DECAY: ScenarioConfig = {
  id: "E-progressive-decay",
  label: "E · Progressive decay",
  description:
    "Base $100 / 24h that decays 20% per prior claim, floored at $40. Generous on the first claim of the window, throttling serial claimers thereafter.",
  cap: {
    kind: "progressive_decay",
    baseCapUsd: 100,
    windowHours: 24,
    decayPerClaim: 0.2,
    floorCapUsd: 40,
  },
  schemaVersion: 1,
};

// ─── Library aggregate ────────────────────────────────────────────────────────

/** The full shippable scenario library (A–E), baseline first. */
export const SCENARIO_LIBRARY: ScenarioConfig[] = [
  SCENARIO_A_BASELINE,
  SCENARIO_B_HOURLY_5,
  SCENARIO_B_HOURLY_10,
  SCENARIO_C_SIXH_15,
  SCENARIO_C_SIXH_20,
  SCENARIO_D_HYBRID,
  SCENARIO_E_DAILY_50,
  SCENARIO_E_75_24H,
  SCENARIO_E_50_12H,
  SCENARIO_E_WEEKLY_POOLED,
  SCENARIO_E_PROGRESSIVE_DECAY,
];

// ─── Split-cap what-if set (the comparison-table rows) ────────────────────────

const SPLIT_CAP_10HR: ScenarioConfig = {
  id: "split-10hr",
  label: "$10 / hour",
  description: "Hourly tranche: $10 per rolling 1h window.",
  cap: { kind: "split_window", capUsd: 10, windowHours: 1 },
  schemaVersion: 1,
};

const SPLIT_CAP_5HR: ScenarioConfig = {
  id: "split-5hr",
  label: "$5 / hour",
  description: "Hourly tranche: $5 per rolling 1h window.",
  cap: { kind: "split_window", capUsd: 5, windowHours: 1 },
  schemaVersion: 1,
};

const SPLIT_CAP_20_6H: ScenarioConfig = {
  id: "split-20-6h",
  label: "$20 / 6h",
  description: "6-hour tranche: $20 per rolling 6h window.",
  cap: { kind: "split_window", capUsd: 20, windowHours: 6 },
  schemaVersion: 1,
};

const SPLIT_CAP_15_6H: ScenarioConfig = {
  id: "split-15-6h",
  label: "$15 / 6h",
  description: "6-hour tranche: $15 per rolling 6h window.",
  cap: { kind: "split_window", capUsd: 15, windowHours: 6 },
  schemaVersion: 1,
};

const SPLIT_CAP_50_12H: ScenarioConfig = {
  id: "split-50-12h",
  label: "$50 / 12h",
  description: "$50 per rolling 12h window — two tranches a day.",
  cap: { kind: "split_window", capUsd: 50, windowHours: 12 },
  schemaVersion: 1,
};

const SPLIT_CAP_75_24H: ScenarioConfig = {
  id: "split-75-24h",
  label: "$75 / 24h",
  description: "$75 per 24h window — a modest trim of the baseline ceiling.",
  cap: { kind: "fixed_window", capUsd: 75, windowHours: 24 },
  schemaVersion: 1,
};

/**
 * Explicit split-cap comparison set. Row 0 is the baseline ($100/24h) so the
 * table's savings columns are populated relative to the current policy.
 */
export const SPLIT_CAP_WHATIF_SET: ScenarioConfig[] = [
  SCENARIO_A_BASELINE,
  SPLIT_CAP_10HR,
  SPLIT_CAP_5HR,
  SPLIT_CAP_20_6H,
  SPLIT_CAP_15_6H,
  SPLIT_CAP_50_12H,
  SPLIT_CAP_75_24H,
];

/** The id of the reference (baseline) scenario shared by both sets. */
export const BASELINE_SCENARIO_ID = SCENARIO_A_BASELINE.id;
