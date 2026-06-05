/**
 * engine.ts — the pure AFFILIATE commission forecast simulator.
 *
 * Side-effect-free, dep-free, primitives-only (mirrors the deposit-bonus
 * reference + `edge-calc/math.ts`). Imports ONLY `constants.ts` + `types.ts` +
 * the shared engine kit's GENERIC orchestration. No DB, no React, no Date, no
 * RNG. Safe to call from a server component, the client island's `useMemo`, the
 * check harness, or a future export — same numbers everywhere.
 *
 * ── House-POV ──────────────────────────────────────────────────────────────
 * Every money output is from the HOUSE perspective:
 *   • `bonusCost` (commission paid) / `abuseLeakage` are house OUTFLOWS (rose /
 *     amber).
 *   • positive `ngrImpact` / `netSavingsVsBaseline` = house GAIN (emerald).
 *
 * ── Directional contract (hard-encoded — this is the spec) ──────────────────
 *  | Lever                                  | Encoded effect                  |
 *  |----------------------------------------|---------------------------------|
 *  | Lower blended commission rate          | ↓ commission cost → POSITIVE    |
 *  | (flat trim / per-tier trim)            | gross savings (cost monotone in |
 *  |                                        | the blended rate).              |
 *  | Higher qualification threshold         | ↓ low-quality / dormant leakage |
 *  |                                        | (capture rises) BUT ↓ referred  |
 *  |                                        | acquisition → retained revenue  |
 *  |                                        | given up → net < gross.         |
 *  | Referral-quality screen (hybrid)       | screens junk wager out of the   |
 *  |                                        | base → ↓ leakage, modest ↓ cost.|
 *  | Enriching rates above the threshold    | cannibalization rises → worse   |
 *  |                                        | NGR, marginal retention.        |
 */

import {
  BASELINE_BLENDED_RATE,
  BASELINE_TIER_RATE,
  CONFIDENCE_BAND_SPREAD,
  EPSILON,
  FLAT_FRONTLOAD,
  FRICTION_W_QUALITY_SCREEN,
  FRICTION_W_RATE_CUT,
  FRICTION_W_THRESHOLD,
  OVERGENEROUS_CANNIBALIZATION_SLOPE,
  OVERGENEROUS_RATE_THRESHOLD,
  QUALIFICATION_SATURATION_MULT,
  TIER_BASE_LEAKAGE,
  TIERS,
} from "./constants";
import type {
  Assumptions,
  DailyPoint,
  PerSegment,
  RatePolicy,
  ScenarioConfig,
  SimulationResult,
  TierId,
} from "./types";
// The GENERIC numeric guards + orchestration live in the shared engine kit.
// Affiliate re-exports the guards (so its `index.ts` surface mirrors deposit-
// bonus's) and wraps the generic `simulateSet` / `buildDailySeries` /
// `scaleResultMoney` with its policy-aware signatures.
import {
  buildDailySeries as buildDailySeriesGeneric,
  clamp,
  clamp01,
  finite,
  safeDiv,
  scaleResultMoney,
  simulateSet as simulateSetGeneric,
} from "../../../_forecast-engine";

// Re-export the shared numeric guards under the affiliate engine surface so the
// `index.ts` barrel + the self-checks import them from `./engine` like the
// reference does.
export { clamp, clamp01, safeDiv, scaleResultMoney };

// ─── Rate geometry ───────────────────────────────────────────────────────────

/**
 * Resolve the effective commission rate a given TIER faces under a policy,
 * INCLUDING the global `commissionRateMult` lever. Centralizes every policy
 * shape:
 *   • current        — the tier's baseline rate.
 *   • flat_trim      — baseline rate × the uniform `rateMult`.
 *   • per_tier       — baseline rate × the tier's own multiplier.
 *   • qualification  — baseline rate × `rateMult` (rates optionally trimmed on
 *                      top of the threshold tighten; the threshold itself acts on
 *                      VOLUME / leakage, not the per-claim rate).
 *   • hybrid         — baseline rate × the tier's multiplier.
 * Then the global `commissionRateMult` lever scales the result. Always ≥0.
 *
 * `baseTierRate` is the per-tier BASELINE rate map. It defaults to the static
 * `BASELINE_TIER_RATE` placeholder (used by the self-check harness), but the
 * live page passes the REAL rates collapsed from `affiliate_level_configs` so
 * the modeled rates reflect the actual commission ladder.
 */
export function effectiveRateForTier(
  policy: RatePolicy,
  tierId: TierId,
  globalRateMult: number,
  baseTierRate: Record<TierId, number> = BASELINE_TIER_RATE,
): number {
  const base = Math.max(0, finite(baseTierRate[tierId]));
  const g = Math.max(0, finite(globalRateMult));
  switch (policy.kind) {
    case "current":
      return base * g;
    case "flat_trim":
      return base * Math.max(0, finite(policy.rateMult)) * g;
    case "per_tier":
      return base * Math.max(0, finite(policy.perTierRateMult[tierId])) * g;
    case "qualification":
      return base * Math.max(0, finite(policy.rateMult)) * g;
    case "hybrid":
      return base * Math.max(0, finite(policy.perTierRateMult[tierId])) * g;
  }
}

/**
 * The BLENDED commission rate a policy implies across the tier mix — the mix-
 * weighted average of the per-tier effective rates. This is the policy's single
 * representative rate, the analogue of the deposit-bonus "effective daily
 * ceiling": cost is monotone in it. Includes the global rate multiplier.
 */
export function blendedRate(
  policy: RatePolicy,
  mix: Record<TierId, number>,
  globalRateMult: number,
  baseTierRate: Record<TierId, number> = BASELINE_TIER_RATE,
): number {
  let sum = 0;
  let weight = 0;
  for (const t of TIERS) {
    const w = Math.max(0, finite(mix[t.id]));
    sum += effectiveRateForTier(policy, t.id, globalRateMult, baseTierRate) * w;
    weight += w;
  }
  return safeDiv(sum, weight);
}

/**
 * The qualification-threshold MULTIPLIER a policy enforces (1 = current bar).
 * Only `qualification` / `hybrid` raise it; everything else keeps the current bar.
 */
export function thresholdMultiplier(policy: RatePolicy): number {
  switch (policy.kind) {
    case "qualification":
    case "hybrid":
      return Math.max(1, finite(policy.thresholdMult) || 1);
    default:
      return 1;
  }
}

/**
 * The hard referral-quality SCREEN fraction a policy applies (0 = none) — the
 * share of low-quality referral wager actively filtered out of the commission
 * base. Only `hybrid` carries one.
 */
export function qualityScreen(policy: RatePolicy): number {
  return policy.kind === "hybrid" ? clamp01(policy.qualityScreen) : 0;
}

/**
 * How tight a policy's QUALIFICATION bar is vs the baseline, as a 0-1 fraction:
 * 0 at the current bar (mult 1), saturating to 1 at
 * {@link QUALIFICATION_SATURATION_MULT}× the bar. Drives leakage capture (a
 * higher bar locks out the low-quality long tail) and acquisition loss.
 */
export function qualificationTightness(policy: RatePolicy): number {
  const mult = thresholdMultiplier(policy);
  const span = Math.max(EPSILON, QUALIFICATION_SATURATION_MULT - 1);
  return clamp01(safeDiv(mult - 1, span));
}

/**
 * How much a policy CUTS the blended rate vs the baseline blended rate, as a 0-1
 * fraction where 0 = at/above the baseline rate and 1 = rate driven to zero.
 * Drives partner friction (a deeper cut antagonizes affiliates more).
 */
export function rateCutSeverity(
  policy: RatePolicy,
  mix: Record<TierId, number>,
  globalRateMult: number,
  baseTierRate: Record<TierId, number> = BASELINE_TIER_RATE,
  baselineBlended: number = BASELINE_BLENDED_RATE,
): number {
  const ref = Math.max(0, finite(baselineBlended)) || BASELINE_BLENDED_RATE;
  const r = blendedRate(policy, mix, globalRateMult, baseTierRate);
  return clamp01(safeDiv(ref - r, ref));
}

/**
 * Monotone, concave COST-RETENTION FACTOR (0-1) for a policy's blended rate vs
 * the baseline blended rate. Models how much of the baseline commission bill
 * SURVIVES once a policy trims rates. Identical curve to the deposit-bonus
 * payout-retention factor (mean of a truncated Uniform), so the two rewards
 * share the same well-behaved cost monotonicity:
 *
 *   r = clamp01(blendedRate(policy) / baselineBlendedRate)
 *   factor = 2r − r²
 *
 * factor(1) = 1 (rates at/above baseline → full bill), factor(0) = 0, strictly
 * increasing and concave between, so a modest trim bites modestly and an
 * aggressive cut bites hard — but the factor never exceeds 1, so a policy can
 * never cost MORE than the baseline THROUGH THE RATE CHANNEL. (Enriching rates
 * costs more via cannibalization / NGR, not via this factor — same as the
 * reference.)
 */
export function costRetentionFromRate(rate: number, baselineRate: number): number {
  const r = clamp01(safeDiv(Math.max(0, finite(rate)), Math.max(0, finite(baselineRate))));
  return clamp01(2 * r - r * r);
}

// ─── Friction ─────────────────────────────────────────────────────────────────

/**
 * Partner-relations friction composite, 0-100 (higher = worse). Weighted sum of
 * the rate-cut severity, the qualification tightness, and a quality-screen
 * penalty.
 */
export function frictionScore(
  policy: RatePolicy,
  mix: Record<TierId, number>,
  globalRateMult: number,
  baseTierRate: Record<TierId, number> = BASELINE_TIER_RATE,
  baselineBlended: number = BASELINE_BLENDED_RATE,
): number {
  const rateCut = rateCutSeverity(policy, mix, globalRateMult, baseTierRate, baselineBlended);
  const threshold = qualificationTightness(policy);
  const screen = qualityScreen(policy) > 0 ? 1 : 0;

  const raw =
    FRICTION_W_RATE_CUT * rateCut +
    FRICTION_W_THRESHOLD * threshold +
    FRICTION_W_QUALITY_SCREEN * screen;

  return clamp(raw, 0, 100);
}

// ─── Per-tier economics ─────────────────────────────────────────────────────

/** How much of baseline low-quality commission is CAPTURED (prevented) under a tighter bar + quality screen. */
export function leakageCaptureUnderPolicy(
  policy: RatePolicy,
  qualificationElasticity: number,
): number {
  // A higher bar captures leakage in proportion to its tightness × elasticity;
  // a hard quality screen captures its own fraction directly. Combined (never
  // double-counts past 1).
  const fromThreshold = clamp01(clamp01(qualificationElasticity) * qualificationTightness(policy));
  const fromScreen = qualityScreen(policy);
  return clamp01(fromThreshold + fromScreen * (1 - fromThreshold));
}

/** How much referred ACQUISITION is LOST from raising the qualification bar (the cost of capture). */
export function acquisitionLossFromTightening(
  policy: RatePolicy,
  sensitivity: number,
): number {
  return clamp01(clamp01(sensitivity) * qualificationTightness(policy));
}

/**
 * Cannibalization fraction at a given blended rate: a baseline rate that climbs
 * linearly once the blended rate exceeds the over-generous threshold (paying for
 * acquisition that would have happened anyway).
 */
export function cannibalizationAtRate(rate: number, baseRate: number): number {
  // Rates move in percentage points; slope is per +0.01.
  const overPts = Math.max(0, (Math.max(0, finite(rate)) - OVERGENEROUS_RATE_THRESHOLD) / 0.01);
  return clamp01(clamp01(baseRate) + overPts * OVERGENEROUS_CANNIBALIZATION_SLOPE * 0.01);
}

// ─── Core simulate ───────────────────────────────────────────────────────────

/** Normalize a tier mix to fractions summing to 1 (falls back to even). */
export function normalizeTierMix(mix: Record<TierId, number>): Record<TierId, number> {
  const raw = TIERS.map((t) => Math.max(0, finite(mix[t.id])));
  const total = raw.reduce((a, b) => a + b, 0);
  const out = {} as Record<TierId, number>;
  if (total <= EPSILON) {
    const even = 1 / TIERS.length;
    for (const t of TIERS) out[t.id] = even;
    return out;
  }
  TIERS.forEach((t, i) => {
    out[t.id] = raw[i] / total;
  });
  return out;
}

/**
 * Run the full forecast for one scenario.
 *
 * @param scenario   the commission policy to simulate
 * @param assumptions the behavioural / volume levers (sliders)
 * @param window     `{ days }` — horizon length; falls back to assumptions.windowDays
 */
export function simulate(
  scenario: ScenarioConfig,
  assumptions: Assumptions,
  window: { days: number },
): SimulationResult {
  const days = Math.max(1, finite(window.days) || finite(assumptions.windowDays) || 30);
  const policy = scenario.policy;

  const mix = normalizeTierMix(assumptions.tierMix);
  const globalRateMult = Math.max(0, finite(assumptions.commissionRateMult));
  const avgCommission = Math.max(0, finite(assumptions.avgBonusUsd));
  const referralQuality = clamp01(assumptions.referralQuality);

  // The REAL per-tier baseline rates + blended reference (collapsed from
  // `affiliate_level_configs` on the live page). Fall back to the static
  // placeholders when the real config was not threaded (self-check harness).
  const baseTierRate = assumptions.baselineTierRate ?? BASELINE_TIER_RATE;
  const baselineBlended =
    typeof assumptions.baselineBlendedRate === "number" && assumptions.baselineBlendedRate > 0
      ? assumptions.baselineBlendedRate
      : BASELINE_BLENDED_RATE;

  // Policy-derived scalars (computed once).
  const capture = leakageCaptureUnderPolicy(policy, assumptions.qualificationElasticity);
  const acqLoss = acquisitionLossFromTightening(policy, assumptions.acquisitionSensitivity);
  const policyBlendedRate = blendedRate(policy, mix, globalRateMult, baseTierRate);
  const cannRate = cannibalizationAtRate(policyBlendedRate, assumptions.cannibalizationRate);
  const retentionUplift = Math.max(0, finite(assumptions.retentionUplift));
  const screen = qualityScreen(policy);

  // ── Volume — anchored to the REAL measured active-affiliate count, identical
  // across every policy ──
  // Active affiliates over the horizon = real count (measured over
  // `baselinePeriodDays`) linearly scaled to the forecast horizon, then modulated
  // by the claim-probability lever RELATIVE to its real measured default. At the
  // default lever the modulation is 1.0. This is the SAME for every policy: a
  // rate change does not change the active-affiliate COUNT for the period (it
  // changes what each one EARNS — the per-claim commission below).
  const baselineClaimants = Math.max(0, finite(assumptions.baselineClaimants));
  const baselinePeriodDays = Math.max(1, finite(assumptions.baselinePeriodDays));
  const claimProb = clamp01(assumptions.claimProbability);
  const baseClaimProb = clamp01(assumptions.baselineClaimProbability);
  const claimProbFactor = baseClaimProb > EPSILON ? claimProb / baseClaimProb : claimProb;
  const horizonAffiliates =
    baselineClaimants * (Math.max(1, days) / baselinePeriodDays) * claimProbFactor;

  // NOTE on the cost anchor: each tier's per-claim commission uses the
  // cost-retention factor of ITS effective rate vs ITS baseline rate
  // (`baselineTierRate` below). At the neutral global multiplier the `current`
  // policy's factor is 1.0 for every tier, so the baseline scenario's cost
  // anchors EXACTLY on the real total when `simulateSet` applies the anchor.
  const perSegment: PerSegment[] = TIERS.map((tier) => {
    const tierFrac = mix[tier.id];
    // Effective claimants for this tier: dormant/low tiers shrink under a
    // qualification tighten (they fall below the new bar); whales are unaffected.
    // The acquisition loss is weighted by how exposed a tier is to the bar — the
    // base leakage share is a good proxy for "marginal / low-quality" exposure.
    const exposure = clamp01(TIER_BASE_LEAKAGE[tier.id]);
    const tierVolRetention = clamp01(1 - acqLoss * exposure);
    const tierClaimants = horizonAffiliates * tierFrac * tierVolRetention;

    // Per-claim commission: the average commission scaled by THIS policy's rate
    // relative to the baseline rate (the cost-retention factor truncates the
    // bill as rates trim). A quality screen shaves a little more off the base
    // (junk wager removed). This is the channel that makes a lower rate cost
    // LESS while anchoring the baseline on the real total.
    const tierRate = effectiveRateForTier(policy, tier.id, globalRateMult, baseTierRate);
    const baselineTierRate = effectiveRateForTier(
      { kind: "current" },
      tier.id,
      globalRateMult,
      baseTierRate,
    );
    const rateFactor = costRetentionFromRate(tierRate, baselineTierRate);
    const screenFactor = 1 - screen * clamp01(TIER_BASE_LEAKAGE[tier.id]);
    const perClaimCommission = avgCommission * rateFactor * screenFactor;

    // Commission cost: claimants × per-claim commission. House-POV outflow.
    const tierCost = tierClaimants * perClaimCommission;

    // Abuse leakage: the low-quality share of THIS tier's commission, net of
    // capture (threshold tighten + quality screen). The leak share scales with
    // (1 − referralQuality): at quality 1 only a small residual (15% of the
    // tier's base leakage) remains; at quality 0 the full base leakage applies.
    // referralQuality is thus the dominant dial. Tighter policies reduce leakage
    // via reinforcing channels — a lower paid commission, higher capture, and
    // this quality lever — so leakage is monotone-decreasing in tightness.
    const baseLeak = clamp01(TIER_BASE_LEAKAGE[tier.id]);
    const effectiveLeakShare = clamp01(baseLeak * (1 - referralQuality) + 0.15 * baseLeak * referralQuality);
    const tierLeakage = tierCost * effectiveLeakShare * (1 - capture);

    // Retained revenue: quality (non-leak, non-cannibalized) commission × uplift,
    // reduced by acquisition lost to tightening. Only the GENUINE referral base
    // (referralQuality) generates downstream play. Quality-heavy tiers retain more.
    const qualityShare = clamp01((1 - effectiveLeakShare - cannRate));
    const qualityCommission = tierCost * qualityShare * referralQuality;
    const tierRetained = qualityCommission * retentionUplift * (1 - acqLoss);

    // NGR contribution, House-POV: downstream GGR proxy − commission cost. The
    // modeled downstream accretion the commission generates is the retained
    // revenue. Net of cost → NGR delta. Positive = NGR-accretive.
    const tierNgr = tierRetained - tierCost;

    return {
      segment: tier.id,
      label: tier.label,
      claimants: finite(tierClaimants),
      bonusCost: finite(tierCost),
      abuseLeakage: finite(tierLeakage),
      retainedRevenue: finite(tierRetained),
      ngrImpact: finite(tierNgr),
      // Surface the per-claim commission as the tier's "effective cap" analogue
      // (the per-affiliate $ the UI shows in the segment breakdown).
      effectiveCapUsd: finite(perClaimCommission),
    };
  });

  // Aggregate.
  const bonusCost = perSegment.reduce((a, s) => a + s.bonusCost, 0);
  const abuseLeakage = perSegment.reduce((a, s) => a + s.abuseLeakage, 0);
  const retainedRevenue = perSegment.reduce((a, s) => a + s.retainedRevenue, 0);

  // NGR = downstream GGR proxy − bonusCost. House-POV: positive when retention
  // beats cost.
  const ngrImpact = retainedRevenue - bonusCost;

  // Net house P&L attributable to the program = retained − cost − abuseLeakage.
  const marginImpact = retainedRevenue - bonusCost - abuseLeakage;
  const netLoss = Math.max(0, -marginImpact);

  const friction = frictionScore(policy, mix, globalRateMult, baseTierRate, baselineBlended);

  const confidenceBand = {
    low: bonusCost * (1 - CONFIDENCE_BAND_SPREAD),
    mid: bonusCost,
    high: bonusCost * (1 + CONFIDENCE_BAND_SPREAD),
  };

  // savings vs baseline are filled in by the caller-facing wrapper (`simulateSet`)
  // that knows the baseline result; here we return them as 0. The daily series is
  // built against this scenario's own cost.
  const dailySeries = buildDailySeries(policy, days, {
    bonusCost,
    abuseLeakage,
    savingsVsBaselineTotal: 0,
  });

  return {
    scenarioId: scenario.id,
    bonusCost: finite(bonusCost),
    marginImpact: finite(marginImpact),
    netLoss: finite(netLoss),
    savingsVsBaseline: 0,
    netSavingsVsBaseline: 0,
    abuseLeakage: finite(abuseLeakage),
    retainedRevenue: finite(retainedRevenue),
    ngrImpact: finite(ngrImpact),
    frictionScore: finite(friction),
    confidenceBand: {
      low: finite(confidenceBand.low),
      mid: finite(confidenceBand.mid),
      high: finite(confidenceBand.high),
    },
    perSegment,
    dailySeries,
  };
}

/**
 * The daily-pacing FRONT-LOAD factor a policy implies. Commission accrues
 * steadily (cohorts wager day-over-day), so EVERY affiliate policy paces flat —
 * there is no early-claim cluster the way deposit-bonus caps front-load. Kept as
 * a function for parity with the reference + the `ForecastConfig.pacingFrontload`
 * contract.
 */
export function policyFrontload(_policy: RatePolicy): number {
  return FLAT_FRONTLOAD;
}

/**
 * Deterministic daily spread of a horizon total across `days`, using a flat
 * pacing curve (commission accrues evenly). Integrates EXACTLY to the supplied
 * totals (no drift). Thin policy-aware wrapper over the shared `buildDailySeries`
 * so `simulate` + the self-checks call it unchanged.
 */
export function buildDailySeries(
  policy: RatePolicy,
  days: number,
  totals: { bonusCost: number; abuseLeakage: number; savingsVsBaselineTotal: number },
): DailyPoint[] {
  return buildDailySeriesGeneric(policyFrontload(policy), days, totals);
}

/**
 * Run a SET of scenarios and patch in savings-vs-baseline (gross + net) and the
 * daily savings series relative to the designated baseline scenario.
 *
 * When `anchorBaselineCostUsd` is supplied (the REAL production total commission),
 * the whole set is uniformly scaled so the BASELINE scenario's projected cost
 * equals that anchor EXACTLY — every view then reads the real baseline, and other
 * scenarios stay coherent fractions/multiples of it.
 *
 * Thin policy-aware wrapper over the shared, reward-agnostic `simulateSet`.
 *
 * @param scenarios    the scenarios to run (the first matching `baselineId`, or
 *                     the first entry, is the reference)
 * @param assumptions  shared levers
 * @param window       horizon
 * @param baselineId   id of the reference scenario (default: scenarios[0].id)
 * @param anchorBaselineCostUsd  optional real baseline total cost to anchor on
 */
export function simulateSet(
  scenarios: ScenarioConfig[],
  assumptions: Assumptions,
  window: { days: number },
  baselineId?: string,
  anchorBaselineCostUsd?: number | null,
): SimulationResult[] {
  return simulateSetGeneric(scenarios, assumptions, window, simulate, {
    baselineId,
    anchorBaselineCostUsd,
    pacingFrontload: (sc) => policyFrontload(sc.policy),
  });
}
