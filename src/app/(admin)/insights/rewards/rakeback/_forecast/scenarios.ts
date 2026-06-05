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
 *   F — Multi-cadence               (change daily + weekly + monthly TOGETHER:
 *                                    all −20/−35/−50%, daily/monthly-weighted,
 *                                    balanced trims)
 *   G — Instant pre-claim           (the 65% cash-out lever — baseline policy
 *                                    with the pre-claim model on)
 *
 * `RATE_WHATIF_SET` is the focused comparison row set: baseline plus a flat-rate
 * gradient (3% → 7%), the cadence anchors, the headline multi-cadence moves, and
 * the pre-claim scenario — the cleanest "what does moving the policy do" table.
 *
 * Rates are FRACTIONS of wager (0.05 = 5%).
 */

import { BASELINE_CADENCE, BASELINE_RATE_FALLBACK } from "./constants";
import type { ClaimCadence, ScenarioConfig } from "./types";

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

// ─── F — Multi-cadence (adjust daily + weekly + monthly TOGETHER) ─────────────

/**
 * Illustrative per-cadence baseline split (fallback only) whose SUM equals the
 * fallback headline (`BASELINE_RATE_FALLBACK` = 5%): daily 2.5% / weekly 1.5% /
 * monthly 1%. Each F-scenario below multiplies these three baselines by its own
 * per-cadence multiplier, so a combined-cadence policy change is modeled as ONE
 * scenario. The live page derives its REAL per-cadence split from `rakeback_config`
 * (see `live-policy.ts`) — this split only seeds the static fallback + the engine
 * self-checks. Rates are FRACTIONS of wager.
 */
const MC_BASELINE: Record<ClaimCadence, number> = {
  daily: 0.025,
  weekly: 0.015,
  monthly: 0.01,
};

/** Build a `multi_cadence` policy by scaling the baseline split per cadence. */
function multiCadence(
  mult: Record<ClaimCadence, number>,
): Extract<ScenarioConfig["policy"], { kind: "multi_cadence" }> {
  return {
    kind: "multi_cadence",
    perCadenceRate: {
      daily: MC_BASELINE.daily * mult.daily,
      weekly: MC_BASELINE.weekly * mult.weekly,
      monthly: MC_BASELINE.monthly * mult.monthly,
    },
    // Daily is the dominant settlement cadence (breakage + pacing route through it).
    cadence: "daily",
  };
}

export const SCENARIO_F_ALL_MINUS_20: ScenarioConfig = {
  id: "F-all-minus-20",
  label: "F · All cadences −20%",
  description:
    "Trim every cadence 20% together (daily 2.5%→2%, weekly 1.5%→1.2%, monthly 1%→0.8%). A uniform, proportional pull-down of the whole rakeback program — the simplest combined-cadence cost cut, preserving the daily/weekly/monthly balance.",
  policy: multiCadence({ daily: 0.8, weekly: 0.8, monthly: 0.8 }),
  schemaVersion: 1,
};

export const SCENARIO_F_ALL_MINUS_35: ScenarioConfig = {
  id: "F-all-minus-35",
  label: "F · All cadences −35%",
  description:
    "Trim every cadence 35% together (daily 2.5%→1.63%, weekly 1.5%→0.98%, monthly 1%→0.65%). A firmer uniform cut across all three programs — bigger direct savings, more genuine-conversion sacrifice.",
  policy: multiCadence({ daily: 0.65, weekly: 0.65, monthly: 0.65 }),
  schemaVersion: 1,
};

export const SCENARIO_F_ALL_MINUS_50: ScenarioConfig = {
  id: "F-all-minus-50",
  label: "F · All cadences −50%",
  description:
    "Halve every cadence together (daily 2.5%→1.25%, weekly 1.5%→0.75%, monthly 1%→0.5%). The deepest uniform combined-cadence cut — the largest direct cost reduction, but the steepest retention/wager headwind.",
  policy: multiCadence({ daily: 0.5, weekly: 0.5, monthly: 0.5 }),
  schemaVersion: 1,
};

export const SCENARIO_F_DAILY_WEIGHTED: ScenarioConfig = {
  id: "F-daily-weighted",
  label: "F · Daily-weighted",
  description:
    "Shift the mix toward DAILY: raise daily +20% (2.5%→3%) while cutting weekly −40% (1.5%→0.9%) and monthly −60% (1%→0.4%). Rewards frequent, reliable claiming (lowest breakage) and starves the slow, hoardable cadences — concentrates spend where engagement is highest.",
  policy: multiCadence({ daily: 1.2, weekly: 0.6, monthly: 0.4 }),
  schemaVersion: 1,
};

export const SCENARIO_F_MONTHLY_WEIGHTED: ScenarioConfig = {
  id: "F-monthly-weighted",
  label: "F · Monthly-weighted",
  description:
    "Shift the mix toward MONTHLY: cut daily −40% (2.5%→1.5%) while raising monthly +50% (1%→1.5%) and holding weekly. Leans on the slow cadence — higher breakage (more lapses unclaimed) lowers realized cost, at the price of more claim friction.",
  policy: multiCadence({ daily: 0.6, weekly: 1.0, monthly: 1.5 }),
  schemaVersion: 1,
};

export const SCENARIO_F_BALANCED_TRIM: ScenarioConfig = {
  id: "F-balanced-trim",
  label: "F · Balanced trim",
  description:
    "A gentle balanced trim: daily −10%, weekly −15%, monthly −25% — leans the cut slightly harder on the slower, more hoardable cadences while keeping daily nearly intact. A measured combined-cadence saving that protects the frequent-claimer experience.",
  policy: multiCadence({ daily: 0.9, weekly: 0.85, monthly: 0.75 }),
  schemaVersion: 1,
};

export const SCENARIO_F_DEEP_BALANCED_TRIM: ScenarioConfig = {
  id: "F-deep-balanced-trim",
  label: "F · Balanced trim (deep)",
  description:
    "A deeper balanced trim: daily −20%, weekly −30%, monthly −45%. Same shape as the gentle balanced trim but cut harder across the board, taper-weighted toward the slow cadences — a larger combined saving while still shielding daily claimers most.",
  policy: multiCadence({ daily: 0.8, weekly: 0.7, monthly: 0.55 }),
  schemaVersion: 1,
};

// ─── G — Instant pre-claim (the 65% cash-out lever) ───────────────────────────

/**
 * Pre-claim @ discount: the SAME baseline policy, but with the instant pre-claim
 * model turned ON (`preClaim: true`). The adopting fraction (the
 * `preClaimAdoption` lever, default 40%) cashes out ALL their accrued rakeback
 * immediately for the `preClaimDiscount` (default 65%) — eliminating breakage on
 * that portion in exchange for the haircut. The realized cost uses the blended
 * factor `α·discount + (1−α)·(1−breakage)`, so this scenario's net savings (vs
 * the baseline) read directly in the comparison table. Planning model only.
 */
export const SCENARIO_G_PRECLAIM: ScenarioConfig = {
  id: "G-preclaim-65",
  label: "G · Pre-claim @ 65%",
  description:
    "Offer an INSTANT pre-claim: a user cashes out ALL their accrued rakeback (daily + weekly + monthly combined) immediately for a discounted fraction of its worth (the pre-claim discount lever, default 65%). Same headline policy as the baseline — the adopting share (pre-claim adoption lever) takes the discount now (no breakage) while everyone else claims normally. A saving whenever the discount sits below the normal breakage-adjusted payout. Tune the discount + adoption sliders. Planning model — does not change live data.",
  policy: { kind: "flat_rate", rate: BASELINE_RATE_FALLBACK, cadence: BASELINE_CADENCE },
  preClaim: true,
  schemaVersion: 1,
};

// ─── Library aggregate ────────────────────────────────────────────────────────

/** The full shippable scenario library (A–G), baseline first. */
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
  // F — multi-cadence (adjust daily + weekly + monthly together)
  SCENARIO_F_ALL_MINUS_20,
  SCENARIO_F_ALL_MINUS_35,
  SCENARIO_F_ALL_MINUS_50,
  SCENARIO_F_DAILY_WEIGHTED,
  SCENARIO_F_MONTHLY_WEIGHTED,
  SCENARIO_F_BALANCED_TRIM,
  SCENARIO_F_DEEP_BALANCED_TRIM,
  // G — instant pre-claim (the 65% cash-out lever)
  SCENARIO_G_PRECLAIM,
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
 * weekly / monthly rows isolate the cadence→breakage→cost channel; the
 * multi-cadence rows show combined daily+weekly+monthly policy moves (with the
 * cadence breakdown in the policy column); and the pre-claim row surfaces the
 * instant-cashout lever's net savings directly.
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
  // Multi-cadence — change daily + weekly + monthly together
  SCENARIO_F_ALL_MINUS_20,
  SCENARIO_F_ALL_MINUS_50,
  SCENARIO_F_DAILY_WEIGHTED,
  SCENARIO_F_MONTHLY_WEIGHTED,
  // Instant pre-claim @ 65%
  SCENARIO_G_PRECLAIM,
];

/** The id of the reference (baseline) scenario shared by both sets. */
export const BASELINE_SCENARIO_ID = SCENARIO_A_BASELINE.id;
