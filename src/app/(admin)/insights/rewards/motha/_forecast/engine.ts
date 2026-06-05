/**
 * engine.ts — the pure MOTHA GIVEAWAYS forecast simulator.
 *
 * Side-effect-free, dep-free, primitives-only (mirrors the deposit-bonus
 * reference + `edge-calc/math.ts`). Imports ONLY `constants.ts` + `types.ts`
 * and the shared engine kit's generic guards / orchestration. No DB, no React,
 * no Date, no RNG. Safe to call from a server component, the client island's
 * `useMemo`, or a future export — same numbers everywhere.
 *
 * ── House-POV ──────────────────────────────────────────────────────────────
 * Every money output is from the HOUSE perspective. A giveaway is money the
 * house (via the founder account) GIVES OUT:
 *   • `bonusCost` (= giveaway spend) / `abuseLeakage` (= wasteful spend) are
 *     house OUTFLOWS (render rose / amber).
 *   • positive `ngrImpact` / `netSavingsVsBaseline` = house GAIN (emerald) —
 *     a TRIM that spends less than baseline saves the house money.
 *
 * ── Directional contract (hard-encoded — this is the spec) ──────────────────
 *  | Lever / scenario                         | Encoded effect                  |
 *  |------------------------------------------|---------------------------------|
 *  | Lower a channel multiplier (trim a       | ↓ that channel's giveaway cost; |
 *  | channel)                                 | removes its wasteful share first|
 *  |                                          | (capture), but gives up some    |
 *  |                                          | engagement + community goodwill.|
 *  | Lower the OVERALL multiplier             | scales ALL channels down        |
 *  |                                          | together (same trade-offs).     |
 *  | Higher engagement uplift                 | more downstream value retained  |
 *  |                                          | per $1 spent → better NGR.       |
 *  | Higher goodwill sensitivity              | a trim costs more goodwill →    |
 *  |                                          | net savings < gross.            |
 */

import {
  BASELINE_MULTIPLIER,
  CHANNELS,
  COMMUNITY_FRICTION_MAX,
  CONFIDENCE_BAND_SPREAD,
  EPSILON,
  GIVEAWAY_FRONTLOAD,
} from "./constants";
import type {
  Assumptions,
  DailyPoint,
  MothaChannel,
  PerSegment,
  ScenarioConfig,
  SimulationResult,
} from "./types";
// The GENERIC numeric guards + orchestration live in the shared engine kit.
import {
  buildDailySeries as buildDailySeriesGeneric,
  clamp,
  clamp01,
  finite,
  safeDiv,
  scaleResultMoney,
  simulateSet as simulateSetGeneric,
} from "../../../_forecast-engine";

// Re-export the shared numeric guards under this engine's surface so the
// `index.ts` barrel can re-export them (mirrors the deposit-bonus engine).
export { clamp, clamp01, safeDiv, scaleResultMoney };

// ─── Channel-mix normalization ───────────────────────────────────────────────

/**
 * Normalize a channel SPLIT (the real baseline composition) to fractions
 * summing to 1. Falls back to an even split when degenerate (all zero / NaN) so
 * the engine never divides by zero. Reward analogue of `normalizeSegmentMix`.
 */
export function normalizeChannelSplit(
  split: Record<MothaChannel, number>,
): Record<MothaChannel, number> {
  const raw = CHANNELS.map((c) => Math.max(0, finite(split[c.id])));
  const total = raw.reduce((a, b) => a + b, 0);
  const out = {} as Record<MothaChannel, number>;
  if (total <= EPSILON) {
    const even = 1 / CHANNELS.length;
    for (const c of CHANNELS) out[c.id] = even;
    return out;
  }
  CHANNELS.forEach((c, i) => {
    out[c.id] = raw[i] / total;
  });
  return out;
}

/** The live per-channel "keep %" slider value for one channel (flat field). */
export function liveChannelKeep(assumptions: Assumptions, channel: MothaChannel): number {
  switch (channel) {
    case "tips":
      return assumptions.tipsKeep;
    case "rain":
      return assumptions.rainKeep;
    case "sponsorship":
      return assumptions.sponsorshipKeep;
  }
}

/**
 * The EFFECTIVE retained-spend multiplier for one channel under a scenario +
 * the live slider keep-% + the overall multiplier. 1 = unchanged, 0 = fully
 * cut. Each factor is floored at 0; the product is the fraction of that
 * channel's baseline spend that survives. (Allowed to exceed 1 if an admin
 * models a SPEND INCREASE — the engine does not cap it, the UI sliders do.)
 */
export function channelRetention(
  scenario: ScenarioConfig,
  assumptions: Assumptions,
  channel: MothaChannel,
): number {
  const scen = Math.max(0, finite(scenario.channelMultiplier[channel]));
  const live = Math.max(0, finite(liveChannelKeep(assumptions, channel)));
  const overall = Math.max(0, finite(assumptions.overallMultiplier));
  return scen * live * overall;
}

/**
 * The TOTAL spend reduction vs baseline (0-1, where 0 = no cut, 1 = everything
 * cut), weighted by each channel's baseline share. Drives the community-impact
 * "friction" score and the goodwill-loss term. A scenario keeping all channels
 * at 1 reads 0; one zeroing every channel reads 1. Clamped to [0,1] (a modeled
 * spend INCREASE reads 0 reduction).
 */
export function totalSpendReduction(
  scenario: ScenarioConfig,
  assumptions: Assumptions,
): number {
  const split = normalizeChannelSplit(assumptions.baselineChannelSplit);
  let retainedShare = 0;
  for (const c of CHANNELS) {
    retainedShare += split[c.id] * channelRetention(scenario, assumptions, c.id);
  }
  // retainedShare is the fraction of baseline spend kept; reduction = 1 − kept.
  return clamp01(1 - retainedShare);
}

/** Community-impact "friction", 0-100: the total spend reduction scaled up. */
export function communityFrictionScore(
  scenario: ScenarioConfig,
  assumptions: Assumptions,
): number {
  return clamp(totalSpendReduction(scenario, assumptions) * COMMUNITY_FRICTION_MAX, 0, 100);
}

// ─── Core simulate ─────────────────────────────────────────────────────────

/**
 * Run the full forecast for one scenario.
 *
 * The ABSOLUTE scale is set by the real baseline anchor in `simulateSet`
 * (`anchorBaselineCostUsd` = the measured total giveaway $). Within `simulate`
 * we work on a NOMINAL unit total of $1 split across the channels by the real
 * baseline composition, apply each channel's retention multiplier, and let the
 * anchor rescale the whole set so the BASELINE scenario equals the real total
 * exactly and every trim is a coherent fraction of it.
 *
 * @param scenario    the per-channel spend-multiplier policy to simulate
 * @param assumptions the behavioural / mix levers (sliders)
 * @param window      `{ days }` — horizon length; falls back to assumptions.windowDays
 */
export function simulate(
  scenario: ScenarioConfig,
  assumptions: Assumptions,
  window: { days: number },
): SimulationResult {
  const days = Math.max(1, finite(window.days) || finite(assumptions.windowDays) || 30);

  const split = normalizeChannelSplit(assumptions.baselineChannelSplit);
  const engagementUplift = Math.max(0, finite(assumptions.engagementUplift));
  const wasteShare = clamp01(assumptions.wasteShare);
  const wasteCapture = clamp01(assumptions.wasteCaptureElasticity);
  const goodwillSensitivity = clamp01(assumptions.goodwillSensitivity);

  // NOMINAL total giveaway $ over the horizon, built from the descriptive
  // volume × avg levers: (active-days scaled to the horizon) × giveaways/day ×
  // avg giveaway. The real-baseline ANCHOR in `simulateSet` rescales the whole
  // set so the BASELINE scenario reads the real measured total exactly — so V
  // and avg cancel out of the anchored display (the real total is the real
  // total). They DO drive the un-anchored sensitivity sweep (which varies the
  // avg giveaway) so that chart is meaningful rather than flat. Floored at a
  // tiny positive so a 0 lever never collapses the whole set to 0 pre-anchor.
  const baselineActiveDays = Math.max(0, finite(assumptions.baselineClaimants));
  const baselinePeriodDays = Math.max(1, finite(assumptions.baselinePeriodDays));
  const horizonActiveDays = baselineActiveDays * (Math.max(1, days) / baselinePeriodDays);
  const giveawaysPerDay = Math.max(0, finite(assumptions.depositsPerUserPerWindow));
  const avgGiveaway = Math.max(0, finite(assumptions.avgBonusUsd));
  const nominalTotal = Math.max(EPSILON, horizonActiveDays * giveawaysPerDay * avgGiveaway);

  // Per-channel breakdown. Each channel's nominal baseline spend is its real
  // share of the nominal total (anchor rescales to the real $ afterwards). The
  // retained spend applies the scenario × live × overall multiplier.
  const perSegment: PerSegment[] = CHANNELS.map((ch) => {
    const baselineShare = split[ch.id]; // fraction of the nominal total
    const retention = channelRetention(scenario, assumptions, ch.id);
    const channelTrim = clamp01(1 - retention); // how much THIS channel is cut

    // Retained giveaway spend for this channel (nominal). House-POV outflow.
    const segSpend = nominalTotal * baselineShare * retention;

    // Wasteful share of the RETAINED spend, net of the waste removed by the
    // trim (trimming a channel sheds its low-engagement recipients first). At
    // no trim the full `wasteShare` is wasted; a deeper trim captures more of
    // it, so the surviving waste is `wasteShare × (1 − capture × channelTrim)`.
    const survivingWasteShare = clamp01(wasteShare * (1 - wasteCapture * channelTrim));
    const segWaste = segSpend * survivingWasteShare;

    // Retained downstream engagement value: the NON-wasted spend × uplift. This
    // is the modeled goodwill / wager a giveaway dollar buys back (House gain).
    const productiveSpend = segSpend * clamp01(1 - survivingWasteShare);
    const segRetained = productiveSpend * engagementUplift;

    // NGR contribution, House-POV: downstream value − spend. Negative while the
    // giveaway costs more than the engagement it returns (the usual case — a
    // giveaway is a net outflow), less negative as a channel is trimmed.
    const segNgr = segRetained - segSpend;

    return {
      segment: ch.id,
      label: ch.label,
      // "claimants" here = the channel's share of giveaway EVENTS over the
      // horizon (active-days × giveaways/day), weighted by how much of the
      // channel survives. Counts (not money) are NOT rescaled by the money
      // anchor — keep them as a meaningful event volume.
      claimants: finite(horizonActiveDays * giveawaysPerDay * baselineShare * retention),
      bonusCost: finite(segSpend),
      abuseLeakage: finite(segWaste),
      retainedRevenue: finite(segRetained),
      ngrImpact: finite(segNgr),
      // "effective cap" is not a concept here; surface the channel's retention
      // % × 100 so the per-segment panel shows how much of the channel remains.
      effectiveCapUsd: finite(retention * 100),
    };
  });

  // Aggregate (nominal — anchor rescales money fields downstream).
  const bonusCost = perSegment.reduce((a, s) => a + s.bonusCost, 0);
  const abuseLeakage = perSegment.reduce((a, s) => a + s.abuseLeakage, 0);
  const retainedRevenueRaw = perSegment.reduce((a, s) => a + s.retainedRevenue, 0);

  // Community-goodwill loss from the total trim: a fraction of the SPEND SAVED
  // is given back as lost goodwill (tempers net savings). Modeled as a haircut
  // on retained value proportional to the total reduction × sensitivity.
  const reduction = totalSpendReduction(scenario, assumptions);
  const goodwillHaircut = clamp01(reduction * goodwillSensitivity);
  const retainedRevenue = retainedRevenueRaw * (1 - goodwillHaircut);

  // NGR = downstream engagement value − spend. House-POV.
  const ngrImpact = retainedRevenue - bonusCost;

  // Net house P&L attributable to the program = retained − cost − waste (waste
  // is pure leakage on top of cost). netLoss is its positive mirror.
  const marginImpact = retainedRevenue - bonusCost - abuseLeakage;
  const netLoss = Math.max(0, -marginImpact);

  const friction = communityFrictionScore(scenario, assumptions);

  const confidenceBand = {
    low: bonusCost * (1 - CONFIDENCE_BAND_SPREAD),
    mid: bonusCost,
    high: bonusCost * (1 + CONFIDENCE_BAND_SPREAD),
  };

  // Savings vs baseline are patched in by `simulateSet` (a single simulate()
  // can't know the baseline). Build the daily series against this scenario's
  // own cost; savings series is rebuilt by the harness.
  const dailySeries = buildDailySeries(days, {
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
 * The daily-pacing FRONT-LOAD factor this reward implies. Giveaways pace evenly
 * (a founder's cadence is not front-loaded), so it is always flat. Kept as a
 * function for symmetry with the `ForecastConfig.pacingFrontload` contract.
 */
export function giveawayFrontload(_scenario: ScenarioConfig): number {
  return GIVEAWAY_FRONTLOAD;
}

/**
 * Deterministic daily spread of a horizon total across `days` using the flat
 * giveaway pacing curve. Thin wrapper over the shared `buildDailySeries`
 * (which takes the front-load as a plain number) so `simulate` calls it with a
 * stable local signature.
 */
export function buildDailySeries(
  days: number,
  totals: { bonusCost: number; abuseLeakage: number; savingsVsBaselineTotal: number },
): DailyPoint[] {
  return buildDailySeriesGeneric(GIVEAWAY_FRONTLOAD, days, totals);
}

/**
 * Run a SET of scenarios and patch in savings-vs-baseline (gross + net) + the
 * daily savings series relative to the designated baseline scenario.
 *
 * When `anchorBaselineCostUsd` is supplied (the REAL measured total giveaway
 * spend), the whole set is uniformly scaled so the BASELINE scenario's
 * projected cost equals that anchor EXACTLY — every view then reads the real
 * baseline, and trims stay coherent fractions of it.
 *
 * Thin wrapper over the shared, reward-agnostic `simulateSet`: supplies this
 * reward's pure `simulate` + the flat pacing resolver.
 *
 * @param scenarios   the scenarios to run (baseline first)
 * @param assumptions shared levers
 * @param window      horizon
 * @param baselineId  id of the reference scenario (default: scenarios[0].id)
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
    pacingFrontload: giveawayFrontload,
  });
}

// Reference the baseline multiplier constant so a future scenario builder /
// validator can assert the baseline scenario keeps every channel at it. Kept
// exported (not unused) via the scenarios module; re-declared here for clarity.
export const BASELINE_CHANNEL_MULTIPLIER = BASELINE_MULTIPLIER;
