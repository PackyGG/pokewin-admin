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
 *   B — Hourly tranches            ($3/hr, $5/hr, $10/hr, $15/hr)
 *   C — 6-hour tranches            ($15/6h, $20/6h, $25/6h, $30/6h, $40/6h,
 *                                   $50/6h — a clean 15→50 gradient)
 *   D — Hybrid dynamic per-segment (the balanced policy + a strict variant)
 *   E — Hard-cap variants          ($50/day, $75/24h, 12h tranches, weekly
 *                                   pooled, progressive decay)
 *
 * `SPLIT_CAP_WHATIF_SET` is the focused comparison row set: baseline plus a
 * 6h dollar gradient (15/20/25/30/40/50), the hourly anchors, and the 12h/24h
 * tranches the audit asked for.
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

export const SCENARIO_B_HOURLY_3: ScenarioConfig = {
  id: "B-hourly-3",
  label: "B · $3 / hour",
  description:
    "Hourly tranche: $3 enforced over a rolling 1h window. The tightest pacing in the library — chokes serial claiming hardest.",
  cap: { kind: "split_window", capUsd: 3, windowHours: 1 },
  schemaVersion: 1,
};

export const SCENARIO_B_HOURLY_15: ScenarioConfig = {
  id: "B-hourly-15",
  label: "B · $15 / hour",
  description:
    "Hourly tranche: $15 enforced over a rolling 1h window. Looser per-claim ceiling, still paced to a 1h cadence.",
  cap: { kind: "split_window", capUsd: 15, windowHours: 1 },
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

export const SCENARIO_C_SIXH_25: ScenarioConfig = {
  id: "C-6h-25",
  label: "C · $25 / 6h",
  description: "6-hour tranche: $25 per rolling 6h window. Mid-point of the 6h gradient — four $25 tranches a day.",
  cap: { kind: "split_window", capUsd: 25, windowHours: 6 },
  schemaVersion: 1,
};

export const SCENARIO_C_SIXH_30: ScenarioConfig = {
  id: "C-6h-30",
  label: "C · $30 / 6h",
  description: "6-hour tranche: $30 per rolling 6h window. Generous tranche while still capping the daily front-load.",
  cap: { kind: "split_window", capUsd: 30, windowHours: 6 },
  schemaVersion: 1,
};

export const SCENARIO_C_SIXH_40: ScenarioConfig = {
  id: "C-6h-40",
  label: "C · $40 / 6h",
  description: "6-hour tranche: $40 per rolling 6h window. The loose end of the gradient — paces a near-baseline ceiling.",
  cap: { kind: "split_window", capUsd: 40, windowHours: 6 },
  schemaVersion: 1,
};

export const SCENARIO_C_SIXH_50: ScenarioConfig = {
  id: "C-6h-50",
  label: "C · $50 / 6h",
  description: "6-hour tranche: $50 per rolling 6h window. Largest 6h tranche — tight on cadence, generous per claim.",
  cap: { kind: "split_window", capUsd: 50, windowHours: 6 },
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

export const SCENARIO_D_HYBRID_STRICT: ScenarioConfig = {
  id: "D-hybrid-dynamic-strict",
  label: "D · Hybrid dynamic (strict)",
  description:
    "Strict variant of the hybrid: same per-segment shape, same 24h window + 1.25× first-of-day + decay, but every per-segment cap pulled lower (legit $100 / high-value $140 / promo $50 / high-risk $15 / reactivated $80). A tighter overall ceiling — squeezes leakage harder at some cost to retention headroom.",
  cap: {
    kind: "dynamic_segment",
    perSegmentCapUsd: {
      legit_low_risk: 100,
      high_value: 140,
      promo_sensitive: 50,
      high_risk_abuse: 15,
      reactivated_dormant: 80,
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

export const SCENARIO_E_25_12H: ScenarioConfig = {
  id: "E-25-12h",
  label: "E · $25 / 12h",
  description: "$25 per rolling 12h window — two tight tranches a day. A much lower 12h ceiling than the $50 variant.",
  cap: { kind: "split_window", capUsd: 25, windowHours: 12 },
  schemaVersion: 1,
};

export const SCENARIO_E_75_12H: ScenarioConfig = {
  id: "E-75-12h",
  label: "E · $75 / 12h",
  description: "$75 per rolling 12h window — two tranches a day. Generous per-tranche, still paced vs a 24h lump.",
  cap: { kind: "split_window", capUsd: 75, windowHours: 12 },
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

export const SCENARIO_E_WEEKLY_POOLED_150: ScenarioConfig = {
  id: "E-weekly-pooled-150",
  label: "E · $150 / week (pooled)",
  description:
    "A tighter pooled $150 cap across a rolling 7-day period (≈ $21.43/day amortized). The leanest weekly pool — front-load freedom with a much lower ceiling.",
  cap: { kind: "weekly_pooled", capUsd: 150 },
  schemaVersion: 1,
};

export const SCENARIO_E_WEEKLY_POOLED_350: ScenarioConfig = {
  id: "E-weekly-pooled-350",
  label: "E · $350 / week (pooled)",
  description:
    "A roomier pooled $350 cap across a rolling 7-day period (≈ $50/day amortized). Lets high-frequency depositors front-load a full week without a daily wall.",
  cap: { kind: "weekly_pooled", capUsd: 350 },
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

export const SCENARIO_E_PROGRESSIVE_DECAY_AGGRESSIVE: ScenarioConfig = {
  id: "E-progressive-decay-aggressive",
  label: "E · Progressive decay (aggressive)",
  description:
    "Tighter decay than the standard variant: base $75 / 24h that decays 30% per prior claim, floored at $25. A lower starting ceiling and a steeper throttle — bites serial claimers much harder.",
  cap: {
    kind: "progressive_decay",
    baseCapUsd: 75,
    windowHours: 24,
    decayPerClaim: 0.3,
    floorCapUsd: 25,
  },
  schemaVersion: 1,
};

// ─── Library aggregate ────────────────────────────────────────────────────────

/** The full shippable scenario library (A–E), baseline first. */
export const SCENARIO_LIBRARY: ScenarioConfig[] = [
  // A — baseline (always row 0)
  SCENARIO_A_BASELINE,
  // B — hourly tranches ($3 / $5 / $10 / $15)
  SCENARIO_B_HOURLY_3,
  SCENARIO_B_HOURLY_5,
  SCENARIO_B_HOURLY_10,
  SCENARIO_B_HOURLY_15,
  // C — 6-hour tranches (clean $15 → $50 gradient)
  SCENARIO_C_SIXH_15,
  SCENARIO_C_SIXH_20,
  SCENARIO_C_SIXH_25,
  SCENARIO_C_SIXH_30,
  SCENARIO_C_SIXH_40,
  SCENARIO_C_SIXH_50,
  // D — hybrid dynamic per-segment (balanced + strict)
  SCENARIO_D_HYBRID,
  SCENARIO_D_HYBRID_STRICT,
  // E — hard-cap variants (daily / 12h tranches / weekly pooled / decay)
  SCENARIO_E_DAILY_50,
  SCENARIO_E_75_24H,
  SCENARIO_E_25_12H,
  SCENARIO_E_50_12H,
  SCENARIO_E_75_12H,
  SCENARIO_E_WEEKLY_POOLED_150,
  SCENARIO_E_WEEKLY_POOLED,
  SCENARIO_E_WEEKLY_POOLED_350,
  SCENARIO_E_PROGRESSIVE_DECAY,
  SCENARIO_E_PROGRESSIVE_DECAY_AGGRESSIVE,
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

const SPLIT_CAP_25_6H: ScenarioConfig = {
  id: "split-25-6h",
  label: "$25 / 6h",
  description: "6-hour tranche: $25 per rolling 6h window.",
  cap: { kind: "split_window", capUsd: 25, windowHours: 6 },
  schemaVersion: 1,
};

const SPLIT_CAP_30_6H: ScenarioConfig = {
  id: "split-30-6h",
  label: "$30 / 6h",
  description: "6-hour tranche: $30 per rolling 6h window.",
  cap: { kind: "split_window", capUsd: 30, windowHours: 6 },
  schemaVersion: 1,
};

const SPLIT_CAP_40_6H: ScenarioConfig = {
  id: "split-40-6h",
  label: "$40 / 6h",
  description: "6-hour tranche: $40 per rolling 6h window.",
  cap: { kind: "split_window", capUsd: 40, windowHours: 6 },
  schemaVersion: 1,
};

const SPLIT_CAP_50_6H: ScenarioConfig = {
  id: "split-50-6h",
  label: "$50 / 6h",
  description: "6-hour tranche: $50 per rolling 6h window.",
  cap: { kind: "split_window", capUsd: 50, windowHours: 6 },
  schemaVersion: 1,
};

const SPLIT_CAP_25_12H: ScenarioConfig = {
  id: "split-25-12h",
  label: "$25 / 12h",
  description: "$25 per rolling 12h window — two tranches a day.",
  cap: { kind: "split_window", capUsd: 25, windowHours: 12 },
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
 * table's savings columns are populated relative to the current policy. The 6h
 * rows form a clean dollar gradient ($15 → $50) so the table shows how cost /
 * leakage move as the per-tranche ceiling loosens at a fixed cadence.
 */
export const SPLIT_CAP_WHATIF_SET: ScenarioConfig[] = [
  SCENARIO_A_BASELINE,
  // Hourly anchors
  SPLIT_CAP_5HR,
  SPLIT_CAP_10HR,
  // 6h dollar gradient ($15 → $50)
  SPLIT_CAP_15_6H,
  SPLIT_CAP_20_6H,
  SPLIT_CAP_25_6H,
  SPLIT_CAP_30_6H,
  SPLIT_CAP_40_6H,
  SPLIT_CAP_50_6H,
  // 12h / 24h tranches
  SPLIT_CAP_25_12H,
  SPLIT_CAP_50_12H,
  SPLIT_CAP_75_24H,
];

/** The id of the reference (baseline) scenario shared by both sets. */
export const BASELINE_SCENARIO_ID = SCENARIO_A_BASELINE.id;
