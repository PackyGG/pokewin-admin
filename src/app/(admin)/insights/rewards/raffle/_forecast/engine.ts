/**
 * engine.ts — the pure RAFFLE-PRIZES forecast simulator.
 *
 * Side-effect-free, dep-free, primitives-only (mirrors the deposit-bonus
 * reference + `edge-calc/math.ts`). Imports ONLY `constants.ts` + `types.ts`
 * and the shared engine kit's generic guards/orchestration. No DB, no React,
 * no Date, no RNG. Safe to call from a server component, the client island's
 * `useMemo`, or a future export — same numbers everywhere.
 *
 * ── House-POV ──────────────────────────────────────────────────────────────
 * Every money output is from the HOUSE perspective:
 *   • `bonusCost` (raffle prize cost) / `abuseLeakage` (farming-captured prize
 *     value) are house OUTFLOWS (render rose / amber).
 *   • positive `ngrImpact` / `netSavingsVsBaseline` = house GAIN (emerald).
 *
 * ── Directional contract (hard-encoded — this is the spec) ──────────────────
 *  | Lever / policy axis                    | Encoded effect                  |
 *  |----------------------------------------|---------------------------------|
 *  | Smaller prize pool  (poolMult < 1)     | ↓ prize cost (monotone) → gross |
 *  |                                        | savings; ↓ retention base too.  |
 *  | Less-frequent cadence (freqMult < 1)   | ↓ total prize cost AND ↓ winner |
 *  |                                        | volume over the horizon.        |
 *  | Tighter ticket rate (rateMult < 1)     | ↓ farming leakage (capture ↑)   |
 *  |                                        | BUT ↑ participation loss & ↓    |
 *  |                                        | retained revenue → net < gross. |
 *  | Over-generous pool (> threshold)       | cannibalization rises linearly  |
 *  |                                        | → worse NGR, marginal retention.|
 *  | Combo                                  | all three axes at once.         |
 */

import {
  BASELINE_FREQUENCY_MULT,
  BASELINE_PRIZE_POOL_MULT,
  BASELINE_RATE_REFERENCE,
  BASELINE_TICKET_RATE_MULT,
  CONFIDENCE_BAND_SPREAD,
  EPSILON,
  FREQUENCY_CHURN_DEADBAND,
  FREQUENCY_CHURN_SATURATION,
  FRICTION_W_FREQUENCY_CHURN,
  FRICTION_W_RATE_TIGHTNESS,
  MIN_RATE_MULT,
  OVERGENEROUS_CANNIBALIZATION_SLOPE,
  OVERGENEROUS_POOL_MULT_THRESHOLD,
  RAFFLE_FRONTLOAD,
  SEGMENTS,
} from "./constants";
import type {
  Assumptions,
  DailyPoint,
  PerSegment,
  RafflePolicy,
  ScenarioConfig,
  SegmentId,
  SimulationResult,
} from "./types";
// The GENERIC numeric guards + orchestration live in the shared engine kit.
// Raffle re-exports the guards (so its barrel surface is self-contained) and
// wraps the generic `simulateSet` / `buildDailySeries` with its policy-aware
// signatures.
import {
  buildDailySeries as buildDailySeriesGeneric,
  clamp,
  clamp01,
  finite,
  safeDiv,
  scaleResultMoney,
  simulateSet as simulateSetGeneric,
} from "../../../_forecast-engine";

// Re-export the shared numeric guards under the raffle engine surface.
export { clamp, clamp01, safeDiv, scaleResultMoney };

// ─── Policy geometry ─────────────────────────────────────────────────────────

/** The prize-pool size multiplier a policy advertises (baseline = 1.0). */
export function prizePoolMult(policy: RafflePolicy): number {
  switch (policy.kind) {
    case "baseline":
      return BASELINE_PRIZE_POOL_MULT;
    case "prize_pool":
      return Math.max(0, finite(policy.prizePoolMult) || BASELINE_PRIZE_POOL_MULT);
    case "frequency":
    case "ticket_rate":
      return BASELINE_PRIZE_POOL_MULT;
    case "combo":
      return Math.max(0, finite(policy.prizePoolMult) || BASELINE_PRIZE_POOL_MULT);
  }
}

/** The raffle-frequency / cadence multiplier a policy advertises (baseline = 1.0). */
export function frequencyMult(policy: RafflePolicy): number {
  switch (policy.kind) {
    case "baseline":
      return BASELINE_FREQUENCY_MULT;
    case "frequency":
      return Math.max(0, finite(policy.frequencyMult) || BASELINE_FREQUENCY_MULT);
    case "prize_pool":
    case "ticket_rate":
      return BASELINE_FREQUENCY_MULT;
    case "combo":
      return Math.max(0, finite(policy.frequencyMult) || BASELINE_FREQUENCY_MULT);
  }
}

/** The tickets-earned-per-$ multiplier a policy advertises (baseline = 1.0). */
export function ticketRateMult(policy: RafflePolicy): number {
  switch (policy.kind) {
    case "baseline":
      return BASELINE_TICKET_RATE_MULT;
    case "ticket_rate":
      return Math.max(0, finite(policy.ticketRateMult) || BASELINE_TICKET_RATE_MULT);
    case "prize_pool":
    case "frequency":
      return BASELINE_TICKET_RATE_MULT;
    case "combo":
      return Math.max(0, finite(policy.ticketRateMult) || BASELINE_TICKET_RATE_MULT);
  }
}

/**
 * The CONFIGURED cost factor a policy implies, BEFORE volume effects:
 * `prizePoolMult × frequencyMult`. This is the per-window prize-cost scale vs
 * the baseline. Frequency ALSO scales winner volume (handled separately in
 * `simulate`); here it is the cost-per-horizon scale. Always ≥0 and finite.
 */
export function costFactor(policy: RafflePolicy): number {
  return Math.max(0, prizePoolMult(policy) * frequencyMult(policy));
}

/**
 * How TIGHT a ticket-rate is vs the baseline, as a 0-1 fraction where 0 = at
 * (or looser/easier than) the baseline rate and 1 = maximally tight (hardest to
 * earn tickets). A rate BELOW the reference is tighter:
 *
 *   tightness = clamp01( (reference − rateMult) / (reference − MIN_RATE_MULT) )
 *
 * Drives farming capture (more capture the tighter the rate) AND participation
 * loss (more loss the tighter the rate) — the raffle trade-off.
 */
export function rateTightness(policy: RafflePolicy): number {
  const rate = ticketRateMult(policy);
  const span = Math.max(EPSILON, BASELINE_RATE_REFERENCE - MIN_RATE_MULT);
  return clamp01(safeDiv(BASELINE_RATE_REFERENCE - rate, span));
}

/**
 * Cannibalization fraction at a given prize-pool multiplier: a baseline rate
 * that climbs linearly once the pool exceeds the over-generous threshold
 * (prize value paid to users who'd have wagered anyway).
 */
export function cannibalizationAtPool(policy: RafflePolicy, baseRate: number): number {
  const over = Math.max(0, prizePoolMult(policy) - OVERGENEROUS_POOL_MULT_THRESHOLD);
  return clamp01(clamp01(baseRate) + over * OVERGENEROUS_CANNIBALIZATION_SLOPE);
}

/** Farming value CAPTURED (prevented) under a tighter ticket rate. */
export function farmingCaptureUnderTighterRate(policy: RafflePolicy, elasticity: number): number {
  return clamp01(clamp01(elasticity) * rateTightness(policy));
}

/** Genuine participation LOST from tightening the rate (the cost of capture). */
export function participationLossFromTightening(policy: RafflePolicy, sensitivity: number): number {
  return clamp01(clamp01(sensitivity) * rateTightness(policy));
}

// ─── Friction ─────────────────────────────────────────────────────────────────

/**
 * UX/operational friction composite, 0-100 (higher = worse). Weighted sum of:
 *   • rate tightness — a harder ticket rate makes entry less rewarding,
 *   • frequency churn — running raffles much more (fatigue) OR much less (lost
 *     pull) than baseline. Distance of `frequencyMult` from 1.0 beyond a
 *     deadband, saturating at the configured span.
 * Prize-pool size carries NO friction weight (a bigger prize is positive UX).
 */
export function frictionScore(policy: RafflePolicy): number {
  const tightness = rateTightness(policy);

  const freq = frequencyMult(policy);
  const churnDistance = Math.max(0, Math.abs(freq - BASELINE_FREQUENCY_MULT) - FREQUENCY_CHURN_DEADBAND);
  const churn = clamp01(safeDiv(churnDistance, Math.max(EPSILON, FREQUENCY_CHURN_SATURATION)));

  const raw = FRICTION_W_RATE_TIGHTNESS * tightness + FRICTION_W_FREQUENCY_CHURN * churn;
  return clamp(raw, 0, 100);
}

// ─── Segment helpers ─────────────────────────────────────────────────────────

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
 * Per-segment baseline farming intensity multiplier. The `minimum_entrant`
 * cohort carries the full assumed farming share; genuine cohorts carry a
 * decreasing fraction (whales essentially none). Multiplies the global
 * `farmingShare` assumption to localize leakage where it really sits.
 */
function segmentFarmingWeight(segmentId: SegmentId): number {
  switch (segmentId) {
    case "minimum_entrant":
      return 1;
    case "casual_entrant":
      return 0.35;
    case "regular_entrant":
      return 0.12;
    case "whale_entrant":
      return 0.03;
  }
}

/**
 * Per-segment retention strength multiplier — how much downstream play a win to
 * this cohort retains, relative to the global `retentionUplift`. Heavier
 * engagement ⇒ more retention; minimum/farming entrants retain almost nothing.
 */
function segmentRetentionWeight(segmentId: SegmentId): number {
  switch (segmentId) {
    case "whale_entrant":
      return 1.4;
    case "regular_entrant":
      return 1.1;
    case "casual_entrant":
      return 0.7;
    case "minimum_entrant":
      return 0.2;
  }
}

// ─── Core simulate ───────────────────────────────────────────────────────────

/**
 * Run the full raffle forecast for one scenario.
 *
 * @param scenario    the raffle policy to simulate
 * @param assumptions the behavioural / volume levers (sliders)
 * @param window      `{ days }` — horizon length; falls back to assumptions.windowDays
 */
export function simulate(
  scenario: ScenarioConfig,
  assumptions: Assumptions,
  window: { days: number },
): SimulationResult {
  const days = Math.max(1, finite(window.days) || finite(assumptions.windowDays) || 30);
  const policy = scenario.policy;

  const mix = normalizeSegmentMix(assumptions.segmentMix);
  const avgPrize = Math.max(0, finite(assumptions.avgBonusUsd));
  const breakage = clamp01(assumptions.breakageRate);
  const farmingShare = clamp01(assumptions.farmingShare);
  const retentionUplift = Math.max(0, finite(assumptions.retentionUplift));

  // Policy-derived scalars (computed once). Cost is driven through the prize-
  // pool-scaled per-winner prize × the frequency-scaled winner volume below,
  // which together equal the real baseline cost × `costFactor(policy)` at the
  // default lever — so `costFactor` is the exported summary, not recomputed here.
  const fMult = frequencyMult(policy);
  const capture = farmingCaptureUnderTighterRate(policy, assumptions.farmingCaptureElasticity);
  const partLoss = participationLossFromTightening(policy, assumptions.participationSensitivity);
  const cannRate = cannibalizationAtPool(policy, assumptions.cannibalizationRate);

  // ── Volume — anchored to the REAL measured WINNER count ──
  // Winners over the horizon = real winners (measured over `baselinePeriodDays`)
  // linearly scaled to the forecast horizon, modulated by (a) the FREQUENCY
  // multiplier (more raffles ⇒ proportionally more winners) and (b) the claim-
  // probability lever RELATIVE to its real measured default. At the baseline
  // policy + default lever the modulation is 1.0, so volume is exactly the real
  // winner count scaled to the horizon.
  const baselineClaimants = Math.max(0, finite(assumptions.baselineClaimants));
  const baselinePeriodDays = Math.max(1, finite(assumptions.baselinePeriodDays));
  const claimProb = clamp01(assumptions.claimProbability);
  const baseClaimProb = clamp01(assumptions.baselineClaimProbability);
  const claimProbFactor = baseClaimProb > EPSILON ? claimProb / baseClaimProb : claimProb;
  const horizonWinners =
    baselineClaimants * (Math.max(1, days) / baselinePeriodDays) * fMult * claimProbFactor;

  // Per-winner PAID prize value = baseline avg prize scaled by the PRIZE-POOL
  // multiplier only (frequency changes the COUNT of winners, not the value each
  // wins). The cost is `winners × per-winner prize`, which equals the real
  // baseline cost × (prizePool × frequency) at the default lever — i.e. exactly
  // `costFactor`. (The set is anchored to the real total downstream.)
  const perWinnerPrize = avgPrize * prizePoolMult(policy);

  const perSegment: PerSegment[] = SEGMENTS.map((seg) => {
    const segFrac = mix[seg.id];
    const segWinners = horizonWinners * segFrac;

    // Effective per-winner prize ceiling shown for this segment (raffles have no
    // per-segment cap; the pool-scaled avg prize is the representative figure).
    const effectiveCapUsd = perWinnerPrize;

    // Prize cost for this segment = winners × per-winner prize.
    const segPrizeCost = segWinners * perWinnerPrize;

    // Farming leakage: the farming-captured share of THIS segment's prize value,
    // localized by the segment's farming weight, net of rate-tightness capture.
    // Tighter ticket rates reduce leakage via capture (more genuine field).
    const segFarmingShare = clamp01(farmingShare * segmentFarmingWeight(seg.id));
    const segFarmingLeakage = segPrizeCost * segFarmingShare * (1 - capture);

    // Retained revenue: genuine (non-farming, non-cannibalized) prize value ×
    // uplift (scaled by the segment's retention weight), reduced by participation
    // lost to rate tightening. Only the RE-ENGAGED fraction (1 − breakage) can
    // generate downstream play, so breakage shrinks the retention base.
    const genuineShare = clamp01(1 - segFarmingShare - cannRate);
    const genuinePrize = segPrizeCost * genuineShare * (1 - breakage);
    const segRetained =
      genuinePrize * retentionUplift * segmentRetentionWeight(seg.id) * (1 - partLoss);

    // NGR contribution, House-POV: downstream GGR proxy (retained revenue) −
    // prize cost. Positive = NGR-accretive.
    const segNgr = segRetained - segPrizeCost;

    return {
      segment: seg.id,
      label: seg.label,
      claimants: finite(segWinners),
      bonusCost: finite(segPrizeCost),
      abuseLeakage: finite(segFarmingLeakage),
      retainedRevenue: finite(segRetained),
      ngrImpact: finite(segNgr),
      effectiveCapUsd: finite(effectiveCapUsd),
    };
  });

  // Aggregate.
  const bonusCost = perSegment.reduce((a, s) => a + s.bonusCost, 0);
  const abuseLeakage = perSegment.reduce((a, s) => a + s.abuseLeakage, 0);
  const retainedRevenue = perSegment.reduce((a, s) => a + s.retainedRevenue, 0);

  // NGR = downstream GGR proxy − prize cost.
  const ngrImpact = retainedRevenue - bonusCost;

  // Net house P&L attributable to the program = retained − cost − leakage.
  const marginImpact = retainedRevenue - bonusCost - abuseLeakage;
  const netLoss = Math.max(0, -marginImpact);

  const friction = frictionScore(policy);

  const confidenceBand = {
    low: bonusCost * (1 - CONFIDENCE_BAND_SPREAD),
    mid: bonusCost,
    high: bonusCost * (1 + CONFIDENCE_BAND_SPREAD),
  };

  // Savings vs baseline are patched in by `simulateSet` (a single simulate()
  // can't know the baseline). The daily series is built against this scenario's
  // own cost; `simulateSet` rebuilds it once savings are known.
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
 * The daily-pacing FRONT-LOAD factor a raffle policy implies. Raffles pay out
 * in discrete draws spread across the horizon, so every policy is essentially
 * FLAT (1.0). Kept as a function for parity with the deposit-bonus reference and
 * the shared `pacingFrontload` hook.
 */
export function policyFrontload(_policy: RafflePolicy): number {
  return RAFFLE_FRONTLOAD;
}

/**
 * Deterministic daily spread of a horizon total across `days`. Thin policy-aware
 * wrapper over the shared `buildDailySeries` (which takes the front-load as a
 * plain number) — kept with the policy signature so `simulate` calls it
 * unchanged.
 */
export function buildDailySeries(
  policy: RafflePolicy,
  days: number,
  totals: { bonusCost: number; abuseLeakage: number; savingsVsBaselineTotal: number },
): DailyPoint[] {
  return buildDailySeriesGeneric(policyFrontload(policy), days, totals);
}

/**
 * Run a SET of raffle scenarios and patch in savings-vs-baseline (gross + net)
 * and the daily savings series relative to the designated baseline scenario.
 * When `anchorBaselineCostUsd` is supplied (the REAL reconstructed prize cost),
 * the whole set is uniformly scaled so the BASELINE scenario's projected cost
 * equals that anchor EXACTLY — every view then reads the real baseline, and
 * other scenarios stay coherent fractions/multiples of it.
 *
 * Thin policy-aware wrapper over the shared, reward-agnostic `simulateSet`.
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
