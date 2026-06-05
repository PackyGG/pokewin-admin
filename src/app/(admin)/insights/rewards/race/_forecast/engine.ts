/**
 * engine.ts — the pure RACE-PRIZE forecast simulator.
 *
 * Side-effect-free, dep-free, primitives-only (mirrors the deposit-bonus
 * reference + `edge-calc/math.ts`). Imports ONLY `constants.ts` + `types.ts`
 * (and the shared generic guards). No DB, no React, no Date, no RNG. Safe to call
 * from a server component, the client island's `useMemo`, the check harness, or a
 * future export — same numbers everywhere.
 *
 * ── House-POV ──────────────────────────────────────────────────────────────
 * Every money output is from the HOUSE perspective:
 *   • `bonusCost` (prize payout) / `abuseLeakage` (dead-weight prize) are house
 *     OUTFLOWS (render rose / amber).
 *   • positive `ngrImpact` / `netSavingsVsBaseline` = house GAIN (emerald).
 *
 * ── Directional contract (hard-encoded — this is the spec) ──────────────────
 *  | Lever                                   | Encoded effect                   |
 *  |-----------------------------------------|----------------------------------|
 *  | Smaller pool (scaled_pool < 1, reduction| ↓ cost, ↓ dead-weight leakage    |
 *  | > 0, cadence < 1, pool-mult < 1)        | (capture rises) BUT ↑ engagement |
 *  |                                         | loss & ↓ retained revenue →      |
 *  |                                         | net savings < gross.             |
 *  | Steeper curve (steepness > 1)           | pool-neutral; concentrates spend |
 *  |                                         | on the champion, starves the     |
 *  |                                         | tail → ↓ leakage (less wasted on |
 *  |                                         | churned tail winners) but ↑      |
 *  |                                         | friction & some engagement loss. |
 *  | Richer pool (> threshold)               | cannibalization rises linearly   |
 *  |                                         | → worse NGR, marginal retention. |
 *  | Faster cadence (cadence/pool-mult > 1)  | ↑ total cost (more races run);   |
 *  |                                         | grind friction rises.            |
 */

import {
  BASELINE_TIER_SHARE,
  BASELINE_TOP_SHARE,
  CONFIDENCE_BAND_SPREAD,
  EPSILON,
  FREQUENT_CADENCE_FRONTLOAD,
  FRICTION_CADENCE_REFERENCE,
  FRICTION_CADENCE_SATURATION,
  FRICTION_W_CADENCE,
  FRICTION_W_POOL_SHRINK,
  FRICTION_W_STEEPNESS,
  OVERGENEROUS_CANNIBALIZATION_SLOPE,
  OVERGENEROUS_POOL_THRESHOLD,
  SEGMENTS,
  SPARSE_CADENCE_FRONTLOAD,
  SPARSE_CADENCE_THRESHOLD,
  TIER_LEAK_WEIGHT,
  TIER_RANK_WEIGHT,
} from "./constants";
import type {
  Assumptions,
  DailyPoint,
  PerSegment,
  RacePolicy,
  ScenarioConfig,
  SegmentId,
  SimulationResult,
} from "./types";
// The GENERIC numeric guards + orchestration live in the shared engine kit.
// Race re-exports the guards (so its `index.ts` surface is self-contained) and
// wraps the generic `simulateSet` / `buildDailySeries` / `scaleResultMoney` with
// its policy-aware signatures.
import {
  buildDailySeries as buildDailySeriesGeneric,
  clamp,
  clamp01,
  finite,
  safeDiv,
  scaleResultMoney,
  simulateSet as simulateSetGeneric,
} from "../../../_forecast-engine";

// Re-export the shared numeric guards under the race engine surface so existing
// imports (`./engine` → index.ts barrel) stay valid.
export { clamp, clamp01, finite, safeDiv, scaleResultMoney };

// ─── Policy scalars ──────────────────────────────────────────────────────────

/**
 * The PER-RACE POOL FACTOR a policy implies vs the baseline (baseline = 1.0) —
 * i.e. how big the prize a SINGLE race pays the field, independent of how many
 * races run. This is the "reward per race" axis the player-experience model
 * (tightness / friction / cannibalization) reads:
 *   • flat_pool   — 1 (the reference).
 *   • scaled_pool — `poolScale` (clamped ≥0).
 *   • steepness   — 1 (the per-race pool TOTAL is unchanged; only its tier split
 *                   moves).
 *   • cadence     — 1 (changing how OFTEN races run does not change the per-race
 *                   pool — that is captured by {@link policyTotalSpendFactor}).
 *   • reduction   — `1 − reductionPct` (clamped to [0,1]).
 * Always ≥0 and finite.
 */
export function policyPoolFactor(policy: RacePolicy): number {
  switch (policy.kind) {
    case "flat_pool":
      return 1;
    case "scaled_pool":
      return Math.max(0, finite(policy.poolScale));
    case "steepness":
      return 1;
    case "cadence":
      return 1;
    case "reduction":
      return clamp01(1 - clamp01(policy.reductionPct));
  }
}

/**
 * The TOTAL HORIZON SPEND factor a policy implies vs the baseline (baseline =
 * 1.0) — the per-race pool factor scaled by the cadence (how many races run over
 * the horizon). This is the multiplier that drives total prize COST:
 *   totalSpend = perRacePool × cadence.
 * For every policy except `cadence` the cadence is 1, so this equals the per-race
 * pool factor; for `cadence` it is the cadence multiplier (per-race pool = 1).
 * (Volume is anchored to the REAL winner count for the period, so cadence is
 * modeled as a SPEND multiplier rather than inflating the claimant count — its
 * economic effect on total cost is identical.) Always ≥0 and finite.
 */
export function policyTotalSpendFactor(policy: RacePolicy): number {
  return policyPoolFactor(policy) * policyCadenceMult(policy);
}

/**
 * The policy's STEEPNESS exponent (1 = baseline curve). >1 = more top-heavy,
 * <1 = flatter. Only the `steepness` policy moves this; every other policy
 * leaves the baseline curve intact.
 */
export function policySteepness(policy: RacePolicy): number {
  if (policy.kind === "steepness") return Math.max(0, finite(policy.steepness)) || 1;
  return 1;
}

/**
 * The policy's CADENCE multiplier (1 = current frequency). Drives the pacing
 * curve (sparse cadence pays in lumps) AND, for the `cadence` policy, the pool
 * factor. Other policies run at the baseline cadence.
 */
export function policyCadenceMult(policy: RacePolicy): number {
  if (policy.kind === "cadence") return Math.max(0, finite(policy.cadenceMult)) || 1;
  return 1;
}

/**
 * Reshape the baseline tier share by a steepness exponent and renormalize to sum
 * 1. Each tier's weight = `(baselineShare · rankWeight^(s−1))`, i.e. at `s=1` the
 * baseline share is returned unchanged; `s>1` amplifies high-rank tiers, `s<1`
 * flattens toward the tail. Always returns fractions summing to 1.
 *
 * (Using `rankWeight^(s−1)` as the multiplier keeps `s=1` an exact identity on
 * the baseline curve while still letting steepness concentrate/spread monotonically.)
 */
export function tierShareAtSteepness(steepness: number): Record<SegmentId, number> {
  const s = Math.max(0, finite(steepness));
  const weights = SEGMENTS.map((seg) => {
    const base = Math.max(0, finite(BASELINE_TIER_SHARE[seg.id]));
    const rank = Math.max(EPSILON, finite(TIER_RANK_WEIGHT[seg.id]));
    return base * Math.pow(rank, s - 1);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  const out = {} as Record<SegmentId, number>;
  if (total <= EPSILON) {
    SEGMENTS.forEach((seg) => {
      out[seg.id] = BASELINE_TIER_SHARE[seg.id];
    });
    return out;
  }
  SEGMENTS.forEach((seg, i) => {
    out[seg.id] = weights[i] / total;
  });
  return out;
}

/**
 * The effective TOP-HEAVINESS (champion + podium share) of a policy's reshaped
 * curve, after applying its steepness. The reference is {@link BASELINE_TOP_SHARE}.
 */
export function effectiveTopShare(policy: RacePolicy, steepnessMult: number): number {
  const s = policySteepness(policy) * Math.max(0, finite(steepnessMult) || 1);
  const share = tierShareAtSteepness(s);
  return clamp01(share.champion + share.podium);
}

/**
 * How "tight" a policy is vs the baseline, as a 0-1 fraction where 0 = as loose
 * as (or looser/more-generous than) baseline and 1 = maximally tight. Combines
 * two axes:
 *   • pool lowness:   (1 − effectivePoolFactor), floored at 0 (a richer pool is
 *                     not "tight").
 *   • curve steepness:(topShare − baselineTopShare) / (1 − baselineTopShare),
 *                     floored at 0 (a flatter-than-baseline curve is not "tight").
 * Max-dominant blend so EITHER a much smaller pool OR a much steeper curve reads
 * as tighter, and a policy tight on BOTH reads tighter still — never > 1. Drives
 * dead-weight leakage capture (more capture the tighter the policy).
 */
export function tightnessVsBaseline(
  policy: RacePolicy,
  poolMult: number,
  steepnessMult: number,
): number {
  const poolFactor = policyPoolFactor(policy) * Math.max(0, finite(poolMult) || 1);
  const poolLowness = clamp01(1 - poolFactor);

  const topShare = effectiveTopShare(policy, steepnessMult);
  const steepHeadroom = Math.max(EPSILON, 1 - BASELINE_TOP_SHARE);
  const curveSteepness = clamp01(safeDiv(topShare - BASELINE_TOP_SHARE, steepHeadroom));

  const dominant = Math.max(poolLowness, curveSteepness);
  const weaker = Math.min(poolLowness, curveSteepness);
  return clamp01(dominant + weaker * (1 - dominant));
}

// ─── Friction ─────────────────────────────────────────────────────────────────

/**
 * Player-experience friction composite, 0-100 (higher = worse). Weighted sum of
 * pool shrink, curve steepness vs baseline, and cadence grind. A larger / flatter
 * / baseline-cadence policy reads ~0 friction; a tiny, top-heavy, fast-cadence
 * policy saturates toward 100.
 */
export function frictionScore(
  policy: RacePolicy,
  poolMult: number,
  steepnessMult: number,
  cadenceMult: number,
): number {
  const poolFactor = policyPoolFactor(policy) * Math.max(0, finite(poolMult) || 1);
  const poolShrink = clamp01(1 - poolFactor);

  const topShare = effectiveTopShare(policy, steepnessMult);
  const steepHeadroom = Math.max(EPSILON, 1 - BASELINE_TOP_SHARE);
  const steepness = clamp01(safeDiv(topShare - BASELINE_TOP_SHARE, steepHeadroom));

  const cadence = policyCadenceMult(policy) * Math.max(0, finite(cadenceMult) || 1);
  const cadenceSpan = Math.max(EPSILON, FRICTION_CADENCE_SATURATION - FRICTION_CADENCE_REFERENCE);
  const cadenceGrind = clamp01(safeDiv(cadence - FRICTION_CADENCE_REFERENCE, cadenceSpan));

  const raw =
    FRICTION_W_POOL_SHRINK * poolShrink +
    FRICTION_W_STEEPNESS * steepness +
    FRICTION_W_CADENCE * cadenceGrind;

  return clamp(raw, 0, 100);
}

// ─── Per-segment economics ─────────────────────────────────────────────────────

/** How much of baseline dead-weight is CAPTURED (prevented) under a tighter policy. */
export function leakageCaptureUnderTighterPolicy(
  policy: RacePolicy,
  poolMult: number,
  steepnessMult: number,
  elasticity: number,
): number {
  return clamp01(clamp01(elasticity) * tightnessVsBaseline(policy, poolMult, steepnessMult));
}

/** How much engagement (participation) is LOST from pool tightening. */
export function engagementLossFromTightening(
  policy: RacePolicy,
  poolMult: number,
  steepnessMult: number,
  sensitivity: number,
): number {
  return clamp01(clamp01(sensitivity) * tightnessVsBaseline(policy, poolMult, steepnessMult));
}

/**
 * Cannibalization fraction at a given effective pool factor: a baseline rate that
 * climbs linearly once the pool exceeds the over-generous threshold (players who
 * would have wagered anyway scooping a richer pool).
 */
export function cannibalizationAtPool(
  policy: RacePolicy,
  poolMult: number,
  baseRate: number,
): number {
  const poolFactor = policyPoolFactor(policy) * Math.max(0, finite(poolMult) || 1);
  const over = Math.max(0, poolFactor - OVERGENEROUS_POOL_THRESHOLD);
  return clamp01(clamp01(baseRate) + over * OVERGENEROUS_CANNIBALIZATION_SLOPE);
}

// ─── Core simulate ───────────────────────────────────────────────────────────

/** Normalize a segment mix to fractions summing to 1 (falls back to even). */
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

/**
 * Run the full forecast for one race scenario.
 *
 * @param scenario    the prize-pool policy to simulate
 * @param assumptions the behavioural / volume / structural levers (sliders)
 * @param window      `{ days }` — horizon length; falls back to assumptions.windowDays
 */
export function simulate(
  scenario: ScenarioConfig,
  assumptions: Assumptions,
  window: { days: number },
): SimulationResult {
  const days = Math.max(1, finite(window.days) || finite(assumptions.windowDays) || 30);
  const policy = scenario.policy;

  // ── Structural multipliers (global what-if knobs stacked on the scenario) ──
  const poolMult = Math.max(0, finite(assumptions.prizePoolMultiplier) || 1);
  const steepnessMult = Math.max(0, finite(assumptions.tierSteepness) || 1);
  const cadenceMult = Math.max(0, finite(assumptions.raceCadenceMultiplier) || 1);

  // Effective per-horizon TOTAL SPEND factor: the policy's total-spend factor
  // (per-race pool × the policy's intrinsic cadence) × the global pool knob ×
  // the global cadence knob. This is what scales total prize COST.
  const effectiveSpendFactor = policyTotalSpendFactor(policy) * poolMult * cadenceMult;

  // The reshaped tier curve: scenario steepness × the global steepness knob.
  const effectiveSteepness = policySteepness(policy) * steepnessMult;
  const tierShare = tierShareAtSteepness(effectiveSteepness);

  // Per-segment WINNER mix (real position distribution, tunable in the UI).
  const mix = normalizeSegmentMix(assumptions.segmentMix);

  const avgPrize = Math.max(0, finite(assumptions.avgBonusUsd));

  // Policy-derived scalars (computed once).
  const capture = leakageCaptureUnderTighterPolicy(
    policy,
    poolMult,
    steepnessMult,
    assumptions.leakageCaptureElasticity,
  );
  const engagementLoss = engagementLossFromTightening(
    policy,
    poolMult,
    steepnessMult,
    assumptions.engagementSensitivity,
  );
  const cannRate = cannibalizationAtPool(policy, poolMult, assumptions.cannibalizationRate);
  const retentionUplift = Math.max(0, finite(assumptions.retentionUplift));
  const deadweightShare = clamp01(assumptions.deadweightShare);

  // ── Volume — anchored to the REAL measured winner count, identical across
  // every policy ──
  // Winners over the horizon = real winners (measured over `baselinePeriodDays`)
  // linearly scaled to the forecast horizon, then modulated by the claim-
  // probability lever RELATIVE to its real measured default. At the default
  // lever the modulation is 1.0, so volume is exactly the real count scaled to
  // the horizon; moving the slider explores a higher / lower win rate. This is
  // the SAME for every policy: restructuring the pool does not change who wins.
  const baselineClaimants = Math.max(0, finite(assumptions.baselineClaimants));
  const baselinePeriodDays = Math.max(1, finite(assumptions.baselinePeriodDays));
  const claimProb = clamp01(assumptions.claimProbability);
  const baseClaimProb = clamp01(assumptions.baselineClaimProbability);
  const claimProbFactor = baseClaimProb > EPSILON ? claimProb / baseClaimProb : claimProb;
  const horizonClaimants =
    baselineClaimants * (Math.max(1, days) / baselinePeriodDays) * claimProbFactor;

  // Average prize per winner under this policy = baseline avg × the effective
  // TOTAL SPEND factor. Cost scales with BOTH the avg-prize lever (so the
  // sensitivity sweep — which varies avgBonusUsd — bites) AND the policy's
  // spend factor (pool size × cadence). For a faster-cadence policy this inflates
  // the modeled per-winner prize rather than the (real-anchored) winner count, so
  // the AGGREGATE cost is correct (more races ⇒ proportionally more spend) even
  // though the volume anchor stays fixed to the measured winners.
  const policyAvgPrize = avgPrize * effectiveSpendFactor;

  const perSegment: PerSegment[] = SEGMENTS.map((seg) => {
    const segFrac = mix[seg.id];
    const segClaimants = horizonClaimants * segFrac;

    // This tier's per-winner prize: the policy avg prize re-weighted by how much
    // of the POOL this tier captures relative to its share of WINNERS. A
    // top-heavy curve (high tierShare for champion, few champion winners) gives
    // each champion a large prize; a flat curve evens it out. Guard the winner
    // share so a zero-winner tier doesn't divide by zero.
    const tierWeight = segFrac > EPSILON ? safeDiv(tierShare[seg.id], segFrac) : 0;
    const perWinnerPrize = policyAvgPrize * tierWeight;

    // Per-tier prize cost = winners × per-winner prize. Equivalent to
    // (total winners × policy avg prize) × tierShare — i.e. the pool split by the
    // tier curve. House-POV outflow.
    const segPrizeCost = segClaimants * perWinnerPrize;

    // Dead-weight leakage: the dead-weight share of THIS tier's prize, net of
    // capture. The TAIL leaks most (small prizes to churned one-off winners); the
    // champion leaks least (a big winner is far likelier to keep playing). We
    // scale the base dead-weight share UP for the tail and DOWN for the top.
    const tierLeakWeight = TIER_LEAK_WEIGHT[seg.id];
    const segDeadweight = clamp01(deadweightShare * tierLeakWeight);
    const segLeakage = segPrizeCost * segDeadweight * (1 - capture);

    // Retained revenue: the engaged (non-dead-weight, non-cannibalized) prize ×
    // uplift, reduced by engagement lost to tightening. Engaged players wager the
    // prize back → downstream GGR. Top tiers retain more (bigger, stickier winners).
    const engagedShare = clamp01(1 - segDeadweight - cannRate);
    const engagedPrize = segPrizeCost * engagedShare;
    const segRetained = engagedPrize * retentionUplift * (1 - engagementLoss);

    // NGR contribution, House-POV: downstream GGR proxy − prize cost.
    const segNgr = segRetained - segPrizeCost;

    return {
      segment: seg.id,
      label: seg.label,
      claimants: finite(segClaimants),
      bonusCost: finite(segPrizeCost),
      abuseLeakage: finite(segLeakage),
      retainedRevenue: finite(segRetained),
      ngrImpact: finite(segNgr),
      effectiveCapUsd: finite(perWinnerPrize),
    };
  });

  // Aggregate.
  const bonusCost = perSegment.reduce((a, s) => a + s.bonusCost, 0);
  const abuseLeakage = perSegment.reduce((a, s) => a + s.abuseLeakage, 0);
  const retainedRevenue = perSegment.reduce((a, s) => a + s.retainedRevenue, 0);

  // NGR = downstream GGR proxy − prize cost. Positive when retention beats cost.
  const ngrImpact = retainedRevenue - bonusCost;

  // Net house P&L = retained − cost − leakage (leakage is pure waste on top).
  const marginImpact = retainedRevenue - bonusCost - abuseLeakage;
  const netLoss = Math.max(0, -marginImpact);

  const friction = frictionScore(policy, poolMult, steepnessMult, cadenceMult);

  const confidenceBand = {
    low: bonusCost * (1 - CONFIDENCE_BAND_SPREAD),
    mid: bonusCost,
    high: bonusCost * (1 + CONFIDENCE_BAND_SPREAD),
  };

  // savings vs baseline are patched in by `simulateSet` (a single simulate()
  // can't know the baseline). The daily series is built against this scenario's
  // own cost using the cadence-derived pacing curve.
  const dailySeries = buildDailySeries(policy, cadenceMult, days, {
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
 * The daily-pacing FRONT-LOAD factor a policy implies: frequent (daily-race)
 * cadence pays out evenly (flat); sparse cadence (weekly/monthly-dominated, i.e.
 * a low cadence multiplier) pays in lumps on settlement day → front-loaded. This
 * is the race mapping of a policy → the generic pacing number the shared
 * `buildDailySeries` consumes.
 */
export function policyFrontload(policy: RacePolicy, cadenceMult: number): number {
  const cadence = policyCadenceMult(policy) * Math.max(0, finite(cadenceMult) || 1);
  return cadence <= SPARSE_CADENCE_THRESHOLD ? SPARSE_CADENCE_FRONTLOAD : FREQUENT_CADENCE_FRONTLOAD;
}

/**
 * Deterministic daily spread of a horizon total across `days`, using a pacing
 * curve (flat for frequent cadence, front-loaded for sparse cadence) that
 * integrates EXACTLY to the supplied totals (no drift). Accumulates
 * `cumulativeCost`.
 *
 * Thin policy-aware wrapper over the shared `buildDailySeries` (which takes the
 * front-load as a plain number).
 */
export function buildDailySeries(
  policy: RacePolicy,
  cadenceMult: number,
  days: number,
  totals: { bonusCost: number; abuseLeakage: number; savingsVsBaselineTotal: number },
): DailyPoint[] {
  return buildDailySeriesGeneric(policyFrontload(policy, cadenceMult), days, totals);
}

/**
 * Run a SET of scenarios and patch in savings-vs-baseline (gross + net) and the
 * daily savings series relative to the designated baseline scenario.
 *
 * When `anchorBaselineCostUsd` is supplied (the REAL production total prize
 * cost), the whole set is uniformly scaled so the BASELINE scenario's projected
 * cost equals that anchor EXACTLY — every view then reads the real baseline, and
 * other scenarios stay coherent fractions/multiples of it. Omit the anchor (or
 * pass null) to keep the slider-derived absolute scale.
 *
 * Thin policy-aware wrapper over the shared, reward-agnostic `simulateSet`: it
 * supplies race's pure `simulate` + the policy→front-load pacing resolver and
 * preserves a 5-arg signature so the engine self-checks call it unchanged.
 *
 * NB: the pacing resolver here uses the policy's INTRINSIC cadence (the global
 * cadence knob is not visible to the generic harness's per-scenario resolver);
 * `simulate` itself already bakes the global cadence into each scenario's daily
 * series, so the post-savings rebuild differs only in the (small) front-load
 * shape, never in the totals.
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
    pacingFrontload: (sc) => policyFrontload(sc.policy, 1),
  });
}
