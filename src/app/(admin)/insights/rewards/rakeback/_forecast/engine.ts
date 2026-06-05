/**
 * engine.ts — the pure RAKEBACK forecast simulator.
 *
 * Side-effect-free, dep-free, primitives-only (mirrors the deposit-bonus
 * reference + `edge-calc/math.ts`). Imports ONLY `constants.ts` + `types.ts`.
 * No DB, no React, no Date, no RNG. Safe to call from a server component, the
 * client island's `useMemo`, the check harness, or a future export — same
 * numbers everywhere.
 *
 * ── House-POV ──────────────────────────────────────────────────────────────
 * Every money output is from the HOUSE perspective:
 *   • `bonusCost` (the realized rakeback paid) / `abuseLeakage` (farmed-wager
 *     rebate) are house OUTFLOWS (render rose / amber).
 *   • positive `ngrImpact` / `netSavingsVsBaseline` = house GAIN (emerald).
 *
 * ── Directional contract (hard-encoded — this is the spec) ──────────────────
 *  | Lever                                  | Encoded effect                   |
 *  |----------------------------------------|----------------------------------|
 *  | Lower effective rate                   | ↓ realized cost (monotone),      |
 *  |                                        | ↓ farmed-wager leakage (capture  |
 *  |                                        | rises), BUT ↑ genuine conversion |
 *  |                                        | loss + (via elasticity) ↓ wager  |
 *  |                                        | → net savings < gross savings.   |
 *  | Slower cadence (daily→weekly→monthly)  | ↑ breakage → LOWER realized cost |
 *  |                                        | but ↑ friction.                  |
 *  | Shorter expiry                         | ↑ breakage → lower realized cost |
 *  |                                        | (anti-hoarding), ↑ friction.     |
 *  | Tiered / progressive-taper             | whales low rate (kills the       |
 *  |                                        | dollar concentration + keeps     |
 *  |                                        | retention via the floor), small  |
 *  |                                        | players keep a generous rate.    |
 *  | Over-generous rate (> threshold)       | farmed-wager share rises linearly|
 *  |                                        | → worse NGR, marginal retention. |
 */

import {
  BASELINE_CADENCE,
  CADENCE_BREAKAGE_MULT,
  CADENCE_FRICTION,
  CONFIDENCE_BAND_SPREAD,
  EPSILON,
  EXPIRY_BREAKAGE_MAX,
  EXPIRY_FLOOR_DAYS,
  EXPIRY_REFERENCE_DAYS,
  FRICTION_W_CADENCE,
  FRICTION_W_EXPIRY,
  FRICTION_W_RATE_LOWNESS,
  MAX_TIER_RANK,
  OVERGENEROUS_FARM_SLOPE,
  OVERGENEROUS_RATE_THRESHOLD,
  SEGMENTS,
  SEGMENT_TIER_RANK,
  cadenceFrontload,
} from "./constants";
import type {
  Assumptions,
  ClaimCadence,
  DailyPoint,
  PerSegment,
  RatePolicy,
  ScenarioConfig,
  SegmentId,
  SimulationResult,
} from "./types";
// The GENERIC numeric guards + orchestration live in the shared engine kit.
// Rakeback re-exports the guards (so its `index.ts` surface is self-contained)
// and wraps the generic `simulateSet` / `buildDailySeries` / `scaleResultMoney`
// with its policy-aware signatures (so `__checks__/run.ts` reads cleanly).
import {
  buildDailySeries as buildDailySeriesGeneric,
  clamp,
  clamp01,
  finite,
  safeDiv,
  scaleResultMoney,
  simulateSet as simulateSetGeneric,
} from "../../../_forecast-engine";

// Re-export the shared numeric guards under the rakeback engine surface so the
// barrel (`index.ts`) and the self-checks import them from one place.
export { clamp, clamp01, finite, safeDiv, scaleResultMoney };

// ─── Rate geometry ────────────────────────────────────────────────────────────

/**
 * Resolve the effective rakeback RATE (fraction of wager) a given segment faces
 * under a policy. Centralizes EVERY policy shape:
 *   • flat_rate / cadence_gated / expiry_capped — the flat `rate` for everyone.
 *   • tiered_by_wager   — the per-segment rate.
 *   • progressive_taper — baseRate × (1 − taperPerTier · tierRank), floored at
 *                         floorRate. Higher wager tier → more taper.
 * Always ≥0 and finite.
 */
export function effectiveRateForSegment(policy: RatePolicy, segmentId: SegmentId): number {
  switch (policy.kind) {
    case "flat_rate":
    case "cadence_gated":
    case "expiry_capped":
      return Math.max(0, finite(policy.rate));
    case "tiered_by_wager":
      return Math.max(0, finite(policy.perSegmentRate[segmentId]));
    case "progressive_taper": {
      const taper = clamp01(policy.taperPerTier);
      const rank = SEGMENT_TIER_RANK[segmentId] ?? 0;
      const tapered = finite(policy.baseRate) * (1 - taper * rank);
      return Math.max(Math.max(0, finite(policy.floorRate)), Math.max(0, tapered));
    }
  }
}

/**
 * The wager-WEIGHTED blended effective rate of a policy under a wager mix — the
 * single number comparable to the real baseline blended rate. For a flat policy
 * this is just the flat rate; for tiered / tapered it is Σ(mixₛ · rateₛ). This
 * is what drives cost (blended rate × wager) and rate-tightness vs baseline.
 */
export function blendedEffectiveRate(
  policy: RatePolicy,
  mix: Record<SegmentId, number>,
): number {
  const norm = normalizeSegmentMix(mix);
  let blended = 0;
  for (const seg of SEGMENTS) {
    blended += norm[seg.id] * effectiveRateForSegment(policy, seg.id);
  }
  return Math.max(0, finite(blended));
}

/**
 * How far BELOW the baseline blended rate a policy's blended effective rate
 * sits, as a 0-1 fraction (0 = at/above baseline, 1 = a zero rate). Drives
 * farmed-wager capture and genuine-conversion loss. See `RATE_TIGHTNESS_MODEL`.
 */
export function rateTightnessVsBaseline(
  policy: RatePolicy,
  mix: Record<SegmentId, number>,
  baselineRate: number,
): number {
  const base = Math.max(0, finite(baselineRate));
  if (base <= EPSILON) return 0;
  const eff = blendedEffectiveRate(policy, mix);
  return clamp01(safeDiv(base - eff, base));
}

/**
 * How far ABOVE the baseline blended rate a policy sits, as a 0-1 fraction
 * (0 = at/below baseline, 1 = double-or-more the baseline). The mirror of
 * {@link rateTightnessVsBaseline} — used for the conversion / wager UPLIFT a
 * MORE generous rate buys (genuine players get more reason to play).
 */
export function rateLoosenessVsBaseline(
  policy: RatePolicy,
  mix: Record<SegmentId, number>,
  baselineRate: number,
): number {
  const base = Math.max(0, finite(baselineRate));
  if (base <= EPSILON) return 0;
  const eff = blendedEffectiveRate(policy, mix);
  return clamp01(safeDiv(eff - base, base));
}

// ─── Breakage ───────────────────────────────────────────────────────────────

/**
 * The expiry-driven breakage COMPONENT (0-1) a policy adds on top of the base
 * breakage. Only `expiry_capped` carries an expiry; everything else returns 0.
 * A shorter expiry forfeits more accrual → larger component (see
 * `EXPIRY_*` constants).
 */
export function expiryBreakageComponent(policy: RatePolicy): number {
  if (policy.kind !== "expiry_capped") return 0;
  const span = Math.max(EPSILON, EXPIRY_REFERENCE_DAYS - EXPIRY_FLOOR_DAYS);
  const shortness = clamp01(safeDiv(EXPIRY_REFERENCE_DAYS - finite(policy.expiryDays), span));
  return EXPIRY_BREAKAGE_MAX * shortness;
}

/**
 * The EFFECTIVE breakage fraction a policy realizes (0-1): the base breakage
 * lever scaled by the cadence multiplier (slower cadence → more lapses), plus
 * the expiry-driven component, clamped to [0,1].
 *
 * This is the channel that lets cadence / expiry lower REALIZED cost without
 * touching the gross accrued rate: realized cost = gross accrual × (1 − breakage).
 */
export function effectiveBreakage(policy: RatePolicy, baseBreakage: number): number {
  const base = clamp01(baseBreakage);
  const cadenceMult = CADENCE_BREAKAGE_MULT[policy.cadence] ?? 1;
  const fromCadence = clamp01(base * cadenceMult);
  return clamp01(fromCadence + expiryBreakageComponent(policy));
}

// ─── Leakage (farmed wager) ───────────────────────────────────────────────────

/**
 * How much of baseline farmed-wager leakage is CAPTURED (prevented) under a
 * lower rate. A lower rate gives farmers less to harvest, so leakage falls with
 * rate tightness × elasticity. Monotone-increasing in tightness.
 */
export function farmCaptureUnderLowerRate(
  policy: RatePolicy,
  mix: Record<SegmentId, number>,
  baselineRate: number,
  elasticity: number,
): number {
  return clamp01(clamp01(elasticity) * rateTightnessVsBaseline(policy, mix, baselineRate));
}

/**
 * Genuine downstream conversion LOST from cutting the rate (the cost of the
 * capture). Symmetric to capture: a lower rate gives genuine players less
 * reason to play. Monotone-increasing in tightness × sensitivity.
 */
export function conversionLossFromRateCut(
  policy: RatePolicy,
  mix: Record<SegmentId, number>,
  baselineRate: number,
  sensitivity: number,
): number {
  return clamp01(clamp01(sensitivity) * rateTightnessVsBaseline(policy, mix, baselineRate));
}

/**
 * Farmed-wager fraction at a given rate (blended OR per-tier): a baseline rate
 * that climbs linearly once the rate exceeds the over-generous threshold (a too-
 * generous rate attracts pure farmers). Called with the BLENDED rate for the
 * program-level figure and with a TIER's own rate for the per-tier leakage —
 * a tier rewarded above the threshold attracts more farming THERE, even if the
 * blended rate is lower (the canonical "rich dormant-tier rate over-farms" case).
 */
export function farmedShareAtRate(rate: number, baseFarmShare: number): number {
  const over = Math.max(0, finite(rate) - OVERGENEROUS_RATE_THRESHOLD);
  // `over` is in rate units (fraction of wager); the slope is per 0.01 (1pp),
  // so scale by 100 to convert the rate excess into "percentage points over".
  return clamp01(clamp01(baseFarmShare) + over * 100 * OVERGENEROUS_FARM_SLOPE * 0.01);
}

/**
 * How tight a SINGLE rate is vs the baseline rate, as a 0-1 fraction (0 = at/
 * above baseline, 1 = a zero rate). The per-tier analogue of
 * {@link rateTightnessVsBaseline} (which blends across the mix). Lets the per-
 * tier leakage capture respond to THAT tier's rate: a tier whose rate is BELOW
 * baseline captures farming there, a tier ABOVE baseline captures none.
 */
export function rateTightnessForRate(rate: number, baselineRate: number): number {
  const base = Math.max(0, finite(baselineRate));
  if (base <= EPSILON) return 0;
  return clamp01(safeDiv(base - Math.max(0, finite(rate)), base));
}

/**
 * Per-tier farm CAPTURE from a tier's own rate vs the baseline rate. A tier with
 * a lower-than-baseline rate gives farmers less to harvest there (capture > 0);
 * a tier at/above baseline captures nothing (and its farmed share rises via
 * {@link farmedShareAtRate}). Monotone-increasing in the tier's tightness ×
 * elasticity — so lowering a tier's rate ALWAYS reduces that tier's leakage.
 */
export function farmCaptureForRate(
  rate: number,
  baselineRate: number,
  elasticity: number,
): number {
  return clamp01(clamp01(elasticity) * rateTightnessForRate(rate, baselineRate));
}

// ─── Wager elasticity ───────────────────────────────────────────────────────

/**
 * The total-wager MULTIPLIER a policy implies vs the baseline, via wager
 * elasticity. A more generous rate lifts wager (×>1); a tighter rate trims it
 * (×<1). Bounded so a degenerate elasticity can't drive wager negative or
 * unboundedly high:
 *
 *   mult = 1 + elasticity·looseness − elasticity·tightness
 *
 * At the baseline rate (looseness = tightness = 0) the multiplier is 1.0 — the
 * baseline reproduces the real wager exactly. Clamped to [0.25, 2.0].
 */
export function wagerMultiplier(
  policy: RatePolicy,
  mix: Record<SegmentId, number>,
  baselineRate: number,
  elasticity: number,
): number {
  const el = clamp01(elasticity);
  const loose = rateLoosenessVsBaseline(policy, mix, baselineRate);
  const tight = rateTightnessVsBaseline(policy, mix, baselineRate);
  return clamp(1 + el * loose - el * tight, 0.25, 2.0);
}

// ─── Friction ─────────────────────────────────────────────────────────────────

/**
 * UX friction composite, 0-100 (higher = worse). Weighted sum of:
 *   • rate lowness  — how far below the baseline blended rate (over-generous adds 0),
 *   • cadence       — slower cadence adds its full weight (daily 0 → monthly 1),
 *   • expiry        — a short expiry adds proportional friction (its breakage
 *                     component, normalized by the max, is a clean 0-1 proxy).
 */
export function frictionScore(
  policy: RatePolicy,
  mix: Record<SegmentId, number>,
  baselineRate: number,
): number {
  const rateLowness = rateTightnessVsBaseline(policy, mix, baselineRate);
  const cadenceFr = CADENCE_FRICTION[policy.cadence] ?? 0;
  const expiryFr = clamp01(safeDiv(expiryBreakageComponent(policy), EXPIRY_BREAKAGE_MAX));

  const raw =
    FRICTION_W_RATE_LOWNESS * rateLowness +
    FRICTION_W_CADENCE * cadenceFr +
    FRICTION_W_EXPIRY * expiryFr;

  return clamp(raw, 0, 100);
}

// ─── Segment mix ──────────────────────────────────────────────────────────────

/** Normalize a wager mix to fractions summing to 1 (falls back to even). */
export function normalizeSegmentMix(mix: Record<SegmentId, number>): Record<SegmentId, number> {
  const raw = SEGMENTS.map((s) => Math.max(0, finite(mix[s.id])));
  const total = raw.reduce((a, b) => a + b, 0);
  const out = {} as Record<SegmentId, number>;
  if (total <= EPSILON) {
    const even = 1 / SEGMENTS.length;
    for (const s of SEGMENTS) out[s.id] = even;
    return out;
  }
  SEGMENTS.forEach((s, i) => {
    out[s.id] = raw[i] / total;
  });
  return out;
}

// ─── Core simulate ───────────────────────────────────────────────────────────

/**
 * Run the full forecast for one rakeback scenario.
 *
 * @param scenario    the rate policy to simulate
 * @param assumptions the behavioural / volume levers (sliders)
 * @param window      `{ days }` — horizon length; falls back to assumptions.windowDays
 *
 * COST MODEL (the crux, distinct from deposit-bonus's cap-truncation):
 *   grossAccrual = totalWager(horizon) × blendedEffectiveRate
 *   realizedCost = grossAccrual × (1 − effectiveBreakage)
 * where totalWager(horizon) = realBaselineWager scaled to the horizon, lifted /
 * trimmed by the wager-elasticity multiplier. At the baseline policy
 * (effectiveRate == baselineRate, daily cadence, no expiry) the multiplier is 1,
 * breakage reads the slider, and the cost reproduces the anchored real total.
 */
export function simulate(
  scenario: ScenarioConfig,
  assumptions: Assumptions,
  window: { days: number },
): SimulationResult {
  const days = Math.max(1, finite(window.days) || finite(assumptions.windowDays) || 30);
  const policy = scenario.policy;

  const mix = normalizeSegmentMix(assumptions.segmentMix);
  const baselineRate = Math.max(0, finite(assumptions.baselineBlendedRate));
  const baselineWager = Math.max(0, finite(assumptions.baselineWager));

  // Policy-derived scalars (computed once). The breakage / conversion-loss /
  // wager-elasticity channels are PROGRAM-level (driven by the blended rate);
  // the farmed-wager leakage is resolved PER TIER inside the loop (driven by
  // each tier's own rate) so a policy that over-rewards a low-value tier
  // correctly over-farms there even when the blended rate is lower.
  const breakage = effectiveBreakage(policy, assumptions.breakageRate);
  const convLoss = conversionLossFromRateCut(
    policy,
    mix,
    baselineRate,
    assumptions.rateConversionSensitivity,
  );
  const farmElasticity = clamp01(assumptions.farmCaptureElasticity);
  const baseFarmShare = clamp01(assumptions.farmedWagerShare);
  const retentionUplift = Math.max(0, finite(assumptions.retentionUplift));
  const wagerMult = wagerMultiplier(policy, mix, baselineRate, assumptions.wagerElasticity);

  // ── Volume — anchored to the REAL measured claimant count, identical across
  // every policy ──
  // Claims over the horizon = real claimants (measured over `baselinePeriodDays`)
  // linearly scaled to the forecast horizon, then modulated by the claim-
  // probability lever RELATIVE to its real measured default. At the default
  // lever the modulation is 1.0. This drives the per-segment claimant SPLIT for
  // the breakdown; the COST is driven by wager (below), not headcount.
  const baselineClaimants = Math.max(0, finite(assumptions.baselineClaimants));
  const baselinePeriodDays = Math.max(1, finite(assumptions.baselinePeriodDays));
  const claimProb = clamp01(assumptions.claimProbability);
  const baseClaimProb = clamp01(assumptions.baselineClaimProbability);
  const claimProbFactor = baseClaimProb > EPSILON ? claimProb / baseClaimProb : claimProb;
  const horizonScale = Math.max(1, days) / baselinePeriodDays;
  const horizonClaimants = baselineClaimants * horizonScale * claimProbFactor;

  // ── Wager over the horizon — the cost base ──
  // Real baseline wager scaled to the horizon and lifted/trimmed by elasticity.
  // This is the dollar volume rakeback is computed against.
  const horizonWager = baselineWager * horizonScale * wagerMult;

  const perSegment: PerSegment[] = SEGMENTS.map((seg) => {
    const segFrac = mix[seg.id];
    const segClaimants = horizonClaimants * segFrac;
    const segWager = horizonWager * segFrac;
    const segRate = effectiveRateForSegment(policy, seg.id);

    // Gross accrual for this tier = its wager × its effective rate. Realized
    // cost reduces it by breakage (accrued-but-unclaimed). House-POV outflow.
    const segGrossAccrual = segWager * segRate;
    const segRealizedCost = segGrossAccrual * (1 - breakage);

    // Farmed-wager leakage: the farmed share of THIS tier's realized rakeback,
    // net of capture — both driven by THIS tier's own rate. Farming concentrates
    // in the LOW-VALUE tiers (dormant / low_volume carry the full farmed share;
    // whales / mid a fraction — high-stakes players rarely churn-farm a rebate).
    // The farmed share rises if the tier's rate is over-generous; capture rises
    // (leakage falls) if the tier's rate is BELOW baseline. So lowering ANY
    // tier's rate reduces that tier's leakage; raising a low-value tier's rate
    // raises it — even when the blended rate moves the other way.
    const tierFarmWeight =
      seg.id === "dormant" || seg.id === "low_volume" ? 1 : 0.25;
    const tierFarmShare = farmedShareAtRate(segRate, baseFarmShare);
    const segFarmShare = clamp01(tierFarmShare * tierFarmWeight);
    const segCapture = farmCaptureForRate(segRate, baselineRate, farmElasticity);
    const segLeakage = segRealizedCost * segFarmShare * (1 - segCapture);

    // Retained downstream GGR: the genuine (non-farmed) realized rakeback ×
    // uplift, reduced by conversion lost to the rate cut. Whales/mid retain
    // more (their play is the downstream value); the genuine share excludes the
    // farmed slice.
    const genuineShare = clamp01(1 - segFarmShare);
    const segGenuineRakeback = segRealizedCost * genuineShare;
    const segRetained = segGenuineRakeback * retentionUplift * (1 - convLoss);

    // NGR contribution, House-POV: downstream GGR proxy − realized cost. The
    // modeled downstream accretion the rakeback generates is the retained
    // revenue; net of the realized cost → NGR delta. Positive = NGR-accretive.
    const segNgr = segRetained - segRealizedCost;

    return {
      segment: seg.id,
      label: seg.label,
      claimants: finite(segClaimants),
      bonusCost: finite(segRealizedCost),
      abuseLeakage: finite(segLeakage),
      retainedRevenue: finite(segRetained),
      ngrImpact: finite(segNgr),
      // The "effective cap" slot carries the tier's effective RATE (as a % of
      // wager, ×100 for a readable figure) — the rakeback analogue of a per-
      // segment ceiling. The UI labels this column generically.
      effectiveCapUsd: finite(segRate * 100),
    };
  });

  // Aggregate.
  const bonusCost = perSegment.reduce((a, s) => a + s.bonusCost, 0);
  const abuseLeakage = perSegment.reduce((a, s) => a + s.abuseLeakage, 0);
  const retainedRevenue = perSegment.reduce((a, s) => a + s.retainedRevenue, 0);

  // NGR = downstream GGR proxy − realized cost. House-POV: positive when
  // retention beats cost.
  const ngrImpact = retainedRevenue - bonusCost;

  // Net house P&L attributable to the program = retained − cost − leakage
  // (farmed rebate is pure leakage on top of cost). netLoss is its positive
  // mirror.
  const marginImpact = retainedRevenue - bonusCost - abuseLeakage;
  const netLoss = Math.max(0, -marginImpact);

  const friction = frictionScore(policy, mix, baselineRate);

  const confidenceBand = {
    low: bonusCost * (1 - CONFIDENCE_BAND_SPREAD),
    mid: bonusCost,
    high: bonusCost * (1 + CONFIDENCE_BAND_SPREAD),
  };

  // savings vs baseline are filled in by the caller-facing `simulateSet` that
  // knows the baseline result; here we return them as 0 and let the set patch
  // them. The daily series is built against this scenario's own cost.
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
 * The daily-pacing FRONT-LOAD factor a policy implies: daily-cadence policies
 * pace evenly (flat), slower cadences read slightly front-loaded as early
 * accrual clears first. The rakeback mapping of a policy → the generic pacing
 * number the shared `buildDailySeries` consumes.
 */
export function policyFrontload(policy: RatePolicy): number {
  return cadenceFrontload(policy.cadence);
}

/**
 * Deterministic daily spread of a horizon total across `days`, using a pacing
 * curve (flat for daily cadence, mildly front-loaded for slower cadences) that
 * integrates EXACTLY to the supplied totals (no drift). Accumulates
 * `cumulativeCost`.
 *
 * Thin policy-aware wrapper over the shared `buildDailySeries` (which takes the
 * front-load as a plain number) — kept with the policy signature so `simulate`
 * and the engine self-checks call it unchanged.
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
 * When `anchorBaselineCostUsd` is supplied (the REAL production total rakeback
 * cost), the whole set is uniformly scaled so the BASELINE scenario's projected
 * cost equals that anchor EXACTLY — every view (KPI, table, charts, segment
 * bars) then reads the real baseline, and other scenarios stay coherent
 * fractions/multiples of it. Omit the anchor (or pass null) to keep the slider-
 * derived absolute scale.
 *
 * Thin policy-aware wrapper over the shared, reward-agnostic `simulateSet`: it
 * supplies rakeback's pure `simulate` + the policy→front-load pacing resolver
 * and preserves the 5-arg signature so the live page and the self-checks call
 * it unchanged.
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

// ─── Re-exports of named coefficients used by the self-checks ─────────────────
export { BASELINE_CADENCE, MAX_TIER_RANK };

/** The cadence a policy carries (handy for callers / friction). */
export function policyCadence(policy: RatePolicy): ClaimCadence {
  return policy.cadence;
}
