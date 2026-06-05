/**
 * scenarios.ts — the shippable RAKEBACK scenario library.
 *
 * Plain serializable `ScenarioConfig` objects (no functions / Decimal / Date),
 * so the UI can hand any of these straight into `simulate()` and round-trip
 * them as JSON. The baseline references the named fallback rate / cadence so
 * Scenario A stays the literal current policy (the live page anchors its cost
 * to the real total regardless).
 *
 * Families:
 *   A — Current baseline            (flat 5% / daily, the reference)
 *   B — Flat-rate trims             (3% / 4% / 6% / 7% — a clean rate gradient)
 *   C — Tiered by wager             (whales-low / small-high; balanced + strict)
 *   D — Progressive taper           (generous floor, tapers up the wager tiers)
 *   E — Cadence & expiry variants   (weekly / monthly cadence, 7d / 14d expiry)
 *
 * `RATE_WHATIF_SET` is the focused comparison row set: baseline plus a flat-rate
 * gradient (3% → 7%) and the cadence anchors — the cleanest "what does moving
 * the headline rate / cadence do" table.
 *
 * Rates are FRACTIONS of wager (0.05 = 5%).
 */

import { BASELINE_CADENCE, BASELINE_RATE_FALLBACK } from "./constants";
import type { ScenarioConfig } from "./types";

// ─── A — Current baseline ───────────────────────────────────────────────────

/**
 * NOTE: this static library is the FALLBACK + the self-check test fixture. The
 * LIVE page derives its baseline + what-ifs from the REAL `rakeback_config`
 * cadences via `buildRakebackScenarios` (see `live-policy.ts`); this static set
 * only renders when the real config could not be threaded (config fetch failed
 * / no rows). The flat 3–7% gradient here is therefore ILLUSTRATIVE — it is not
 * a claim about the real policy, and it stays fixed so the engine self-checks
 * (`__checks__/run.ts`, which pin the directional contract on these numbers)
 * keep passing.
 */
export const SCENARIO_A_BASELINE: ScenarioConfig = {
  id: "A-baseline",
  label: "A · Current baseline",
  description: `Reference policy (illustrative fallback): a flat ${(BASELINE_RATE_FALLBACK * 100).toFixed(0)}% of wager, claimable ${BASELINE_CADENCE}. The reference every other scenario is measured against (savings vs baseline = 0; cost anchors to the real total). The live page shows the real per-cadence policy instead.`,
  policy: { kind: "flat_rate", rate: BASELINE_RATE_FALLBACK, cadence: BASELINE_CADENCE },
  schemaVersion: 1,
};

// ─── B — Flat-rate trims (a clean rate gradient) ──────────────────────────────

export const SCENARIO_B_FLAT_3: ScenarioConfig = {
  id: "B-flat-3",
  label: "B · Flat 3%",
  description:
    "Flat 3% of wager, daily cadence. The tightest flat rate in the library — biggest direct cost cut, but the steepest genuine-conversion sacrifice.",
  policy: { kind: "flat_rate", rate: 0.03, cadence: "daily" },
  schemaVersion: 1,
};

export const SCENARIO_B_FLAT_4: ScenarioConfig = {
  id: "B-flat-4",
  label: "B · Flat 4%",
  description:
    "Flat 4% of wager, daily cadence. A modest trim of the baseline rate — cuts cost while keeping a competitive headline rate.",
  policy: { kind: "flat_rate", rate: 0.04, cadence: "daily" },
  schemaVersion: 1,
};

export const SCENARIO_B_FLAT_6: ScenarioConfig = {
  id: "B-flat-6",
  label: "B · Flat 6%",
  description:
    "Flat 6% of wager, daily cadence. A more generous headline rate — lifts wager via elasticity and retention, at a higher direct cost.",
  policy: { kind: "flat_rate", rate: 0.06, cadence: "daily" },
  schemaVersion: 1,
};

export const SCENARIO_B_FLAT_7: ScenarioConfig = {
  id: "B-flat-7",
  label: "B · Flat 7%",
  description:
    "Flat 7% of wager, daily cadence. The loosest flat rate — strongest wager/retention lift, but the costliest and most exposed to farming.",
  policy: { kind: "flat_rate", rate: 0.07, cadence: "daily" },
  schemaVersion: 1,
};

// ─── C — Tiered by wager (the canonical rakeback shape) ───────────────────────

export const SCENARIO_C_TIERED: ScenarioConfig = {
  id: "C-tiered",
  label: "C · Tiered by wager",
  description:
    "Per-tier rate: generous for small / casual players (low 7% / dormant 8%), trimmed for the whale concentration (whales 3.5% / mid 5%). Rewards engagement where it builds habit and throttles the dollar concentration where rakeback costs the most.",
  policy: {
    kind: "tiered_by_wager",
    perSegmentRate: {
      whales: 0.035,
      mid_volume: 0.05,
      low_volume: 0.07,
      dormant: 0.08,
    },
    cadence: "daily",
  },
  schemaVersion: 1,
};

export const SCENARIO_C_TIERED_STRICT: ScenarioConfig = {
  id: "C-tiered-strict",
  label: "C · Tiered (strict)",
  description:
    "Strict variant of the tiered policy: same shape, every tier pulled lower (whales 2.5% / mid 4% / low 5.5% / dormant 6%). A tighter overall rebate — squeezes the whale-heavy cost harder at some retention headroom.",
  policy: {
    kind: "tiered_by_wager",
    perSegmentRate: {
      whales: 0.025,
      mid_volume: 0.04,
      low_volume: 0.055,
      dormant: 0.06,
    },
    cadence: "daily",
  },
  schemaVersion: 1,
};

export const SCENARIO_C_TIERED_GENEROUS: ScenarioConfig = {
  id: "C-tiered-generous",
  label: "C · Tiered (generous)",
  description:
    "Generous variant: small players richly rewarded (low 9% / dormant 10%) while whales stay trimmed (4% / mid 6%). Leans hard into small-player retention; watch the dormant farming exposure at the 10% rate.",
  policy: {
    kind: "tiered_by_wager",
    perSegmentRate: {
      whales: 0.04,
      mid_volume: 0.06,
      low_volume: 0.09,
      dormant: 0.1,
    },
    cadence: "daily",
  },
  schemaVersion: 1,
};

// ─── D — Progressive taper ────────────────────────────────────────────────────

export const SCENARIO_D_TAPER: ScenarioConfig = {
  id: "D-taper",
  label: "D · Progressive taper",
  description:
    "Base 8% at the lowest wager tier, tapering 20% per tier up to the whales, floored at 3%. A smooth anti-whale curve: the more you wager, the lower your marginal rate — generous to the long tail, lean at the top.",
  policy: {
    kind: "progressive_taper",
    baseRate: 0.08,
    cadence: "daily",
    taperPerTier: 0.2,
    floorRate: 0.03,
  },
  schemaVersion: 1,
};

export const SCENARIO_D_TAPER_STEEP: ScenarioConfig = {
  id: "D-taper-steep",
  label: "D · Progressive taper (steep)",
  description:
    "Steeper taper than the standard variant: base 8% but tapering 30% per tier, floored at 2.5%. Bites the whale concentration much harder while keeping the long tail generous.",
  policy: {
    kind: "progressive_taper",
    baseRate: 0.08,
    cadence: "daily",
    taperPerTier: 0.3,
    floorRate: 0.025,
  },
  schemaVersion: 1,
};

// ─── E — Cadence & expiry variants ────────────────────────────────────────────

export const SCENARIO_E_WEEKLY: ScenarioConfig = {
  id: "E-weekly",
  label: "E · Flat 5% / weekly",
  description:
    "Baseline 5% rate but a WEEKLY claim cadence instead of daily. The same gross accrual, but more lapses unclaimed (higher breakage) → lower realized cost, at the price of more claim friction.",
  policy: { kind: "cadence_gated", rate: BASELINE_RATE_FALLBACK, cadence: "weekly" },
  schemaVersion: 1,
};

export const SCENARIO_E_MONTHLY: ScenarioConfig = {
  id: "E-monthly",
  label: "E · Flat 5% / monthly",
  description:
    "Baseline 5% rate on a MONTHLY cadence. Long accrual maximizes breakage (the most unclaimed forfeiture) → the lowest realized cost of the cadence variants, but the highest friction.",
  policy: { kind: "cadence_gated", rate: BASELINE_RATE_FALLBACK, cadence: "monthly" },
  schemaVersion: 1,
};

export const SCENARIO_E_EXPIRY_14: ScenarioConfig = {
  id: "E-expiry-14",
  label: "E · Flat 5% / 14d expiry",
  description:
    "Baseline 5% / daily, but unclaimed accrual EXPIRES after 14 days. A soft anti-hoarding control: forfeits more accrual (higher breakage) → lower realized cost, modest added friction.",
  policy: { kind: "expiry_capped", rate: BASELINE_RATE_FALLBACK, cadence: "daily", expiryDays: 14 },
  schemaVersion: 1,
};

export const SCENARIO_E_EXPIRY_7: ScenarioConfig = {
  id: "E-expiry-7",
  label: "E · Flat 5% / 7d expiry",
  description:
    "Baseline 5% / daily with a tight 7-day expiry on unclaimed accrual. The strongest expiry forfeiture — the lowest realized cost of the expiry variants, at more claim-urgency friction.",
  policy: { kind: "expiry_capped", rate: BASELINE_RATE_FALLBACK, cadence: "daily", expiryDays: 7 },
  schemaVersion: 1,
};

export const SCENARIO_E_TIERED_WEEKLY: ScenarioConfig = {
  id: "E-tiered-weekly",
  label: "E · Tiered / weekly",
  description:
    "The balanced tiered rate (whales 3.5% / mid 5% / low 7% / dormant 8%) on a weekly cadence — combines the whale-throttling tier shape with the breakage savings of a slower cadence.",
  policy: {
    kind: "tiered_by_wager",
    perSegmentRate: {
      whales: 0.035,
      mid_volume: 0.05,
      low_volume: 0.07,
      dormant: 0.08,
    },
    cadence: "weekly",
  },
  schemaVersion: 1,
};

// ─── Library aggregate ────────────────────────────────────────────────────────

/** The full shippable scenario library (A–E), baseline first. */
export const SCENARIO_LIBRARY: ScenarioConfig[] = [
  // A — baseline (always row 0)
  SCENARIO_A_BASELINE,
  // B — flat-rate trims (3% → 7%)
  SCENARIO_B_FLAT_3,
  SCENARIO_B_FLAT_4,
  SCENARIO_B_FLAT_6,
  SCENARIO_B_FLAT_7,
  // C — tiered by wager (balanced / strict / generous)
  SCENARIO_C_TIERED,
  SCENARIO_C_TIERED_STRICT,
  SCENARIO_C_TIERED_GENEROUS,
  // D — progressive taper (standard / steep)
  SCENARIO_D_TAPER,
  SCENARIO_D_TAPER_STEEP,
  // E — cadence & expiry variants
  SCENARIO_E_WEEKLY,
  SCENARIO_E_MONTHLY,
  SCENARIO_E_EXPIRY_14,
  SCENARIO_E_EXPIRY_7,
  SCENARIO_E_TIERED_WEEKLY,
];

// ─── Rate what-if set (the comparison-table rows) ─────────────────────────────

const FLAT_3: ScenarioConfig = {
  id: "rate-flat-3",
  label: "3% flat",
  description: "Flat 3% of wager, daily cadence.",
  policy: { kind: "flat_rate", rate: 0.03, cadence: "daily" },
  schemaVersion: 1,
};

const FLAT_4: ScenarioConfig = {
  id: "rate-flat-4",
  label: "4% flat",
  description: "Flat 4% of wager, daily cadence.",
  policy: { kind: "flat_rate", rate: 0.04, cadence: "daily" },
  schemaVersion: 1,
};

const FLAT_6: ScenarioConfig = {
  id: "rate-flat-6",
  label: "6% flat",
  description: "Flat 6% of wager, daily cadence.",
  policy: { kind: "flat_rate", rate: 0.06, cadence: "daily" },
  schemaVersion: 1,
};

const FLAT_7: ScenarioConfig = {
  id: "rate-flat-7",
  label: "7% flat",
  description: "Flat 7% of wager, daily cadence.",
  policy: { kind: "flat_rate", rate: 0.07, cadence: "daily" },
  schemaVersion: 1,
};

const WEEKLY_5: ScenarioConfig = {
  id: "rate-weekly-5",
  label: "5% weekly",
  description: "Baseline 5% rate on a weekly cadence.",
  policy: { kind: "cadence_gated", rate: BASELINE_RATE_FALLBACK, cadence: "weekly" },
  schemaVersion: 1,
};

const MONTHLY_5: ScenarioConfig = {
  id: "rate-monthly-5",
  label: "5% monthly",
  description: "Baseline 5% rate on a monthly cadence.",
  policy: { kind: "cadence_gated", rate: BASELINE_RATE_FALLBACK, cadence: "monthly" },
  schemaVersion: 1,
};

/**
 * Explicit rate-comparison set. Row 0 is the baseline (5% / daily) so the
 * table's savings columns are populated relative to the current policy. The
 * flat rows form a clean rate gradient (3% → 7%) so the table shows how cost /
 * leakage / retention move as the headline rate shifts at a fixed cadence; the
 * weekly / monthly rows isolate the cadence→breakage→cost channel.
 */
export const RATE_WHATIF_SET: ScenarioConfig[] = [
  SCENARIO_A_BASELINE,
  // Flat rate gradient (3% → 7%)
  FLAT_3,
  FLAT_4,
  FLAT_6,
  FLAT_7,
  // Cadence anchors (rate held at baseline)
  WEEKLY_5,
  MONTHLY_5,
];

/** The id of the reference (baseline) scenario shared by both sets. */
export const BASELINE_SCENARIO_ID = SCENARIO_A_BASELINE.id;
