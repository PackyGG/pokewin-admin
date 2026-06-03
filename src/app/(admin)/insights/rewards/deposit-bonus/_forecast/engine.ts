/**
 * engine.ts — the pure deposit-bonus forecast simulator.
 *
 * Side-effect-free, dep-free, primitives-only (mirrors `edge-calc/math.ts`).
 * Imports ONLY `constants.ts` + `types.ts`. No DB, no React, no Date, no RNG.
 * Safe to call from a server component, the client island's `useMemo`, the
 * check harness, or a future export — same numbers everywhere.
 *
 * ── House-POV ──────────────────────────────────────────────────────────────
 * Every money output is from the HOUSE perspective:
 *   • `bonusCost` / `abuseLeakage` are house OUTFLOWS (render rose / amber).
 *   • positive `ngrImpact` / `netSavingsVsBaseline` = house GAIN (emerald).
 *
 * ── Directional contract (hard-encoded — this is the spec) ──────────────────
 *  | Lever                                  | Encoded effect                  |
 *  |----------------------------------------|---------------------------------|
 *  | Stricter / more-frequent cap           | ↓ abuse leakage (capture rises) |
 *  | (lower $ OR shorter window)            | BUT ↑ conversion loss & ↓       |
 *  |                                        | retained revenue → net < gross. |
 *  | Spaced / split caps (split_window)     | burst leakage × BURST_DAMPING   |
 *  |                                        | (<1) → less leakage than the    |
 *  |                                        | same $ in one 24h lump.         |
 *  | Over-generous cap (> threshold)        | cannibalization rises linearly  |
 *  |                                        | → worse NGR, marginal retention.|
 *  | Dynamic per-segment (hybrid)           | low-risk high cap (retention),  |
 *  |                                        | high-risk low cap (kills leak), |
 *  |                                        | first-of-day mult + decay.      |
 */

import {
  BASELINE_CAP_USD,
  BASELINE_WINDOW_HOURS,
  BASELINE_WINDOWS_PER_DAY,
  CONFIDENCE_BAND_SPREAD,
  EPSILON,
  FIXED_WINDOW_FRONTLOAD,
  FRICTION_MIN_WINDOW_HOURS,
  FRICTION_REFERENCE_WINDOW_HOURS,
  FRICTION_W_CAP_LOWNESS,
  FRICTION_W_DECAY,
  FRICTION_W_WINDOW_TIGHTNESS,
  HOURS_PER_DAY,
  OVERGENEROUS_CANNIBALIZATION_SLOPE,
  OVERGENEROUS_CAP_THRESHOLD_USD,
  SEGMENTS,
  SPLIT_CAP_BURST_DAMPING,
  SPLIT_WINDOW_FRONTLOAD,
  WEEKLY_POOL_DAYS,
} from "./constants";
import type {
  Assumptions,
  CapRule,
  DailyPoint,
  PerSegment,
  ScenarioConfig,
  SegmentId,
  SimulationResult,
} from "./types";

// ─── Small numeric helpers (defensive, edge-calc style) ─────────────────────

/** Clamp a value into [0,1]. Non-finite → 0. */
export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/** Clamp into an arbitrary [lo,hi]. Non-finite → lo. */
export function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

/** Guarded divide — returns 0 when the denominator is ~0 or inputs non-finite. */
export function safeDiv(num: number, den: number): number {
  if (!Number.isFinite(num) || !Number.isFinite(den)) return 0;
  if (Math.abs(den) < EPSILON) return 0;
  return num / den;
}

/** Non-finite → 0; otherwise the value. */
function finite(x: number): number {
  return Number.isFinite(x) ? x : 0;
}

// ─── Cap geometry ────────────────────────────────────────────────────────────

/**
 * The CAP-GEOMETRY window length (hours) a rule enforces — the period over
 * which the dollar ceiling applies. For weekly_pooled this is the full week.
 * Used for friction (how long a user waits for the ceiling to reset) — NOT for
 * claim cadence (see {@link claimCadenceHours}).
 */
export function capWindowHours(cap: CapRule): number {
  switch (cap.kind) {
    case "fixed_window":
    case "split_window":
    case "progressive_decay":
    case "dynamic_segment":
      return Math.max(FRICTION_MIN_WINDOW_HOURS, finite(cap.windowHours) || BASELINE_WINDOW_HOURS);
    case "weekly_pooled":
      return WEEKLY_POOL_DAYS * HOURS_PER_DAY;
  }
}

/**
 * The CLAIM-CADENCE window (hours) — how often a user actually claims, which
 * drives VOLUME. For most rules this equals {@link capWindowHours}. For
 * weekly_pooled it is DAILY (24h): users still deposit/claim daily; the pool
 * only caps the weekly TOTAL. Decoupling cadence from the pool period stops
 * weekly_pooled from being double-penalized (tiny per-claim cap AND a tiny
 * window count) — its volume should mirror a daily-cadence policy.
 */
export function claimCadenceHours(cap: CapRule): number {
  if (cap.kind === "weekly_pooled") return HOURS_PER_DAY;
  return capWindowHours(cap);
}

/**
 * The nominal per-(cadence-)window dollar cap a rule advertises (segment-
 * agnostic), expressed on a comparable per-claim basis:
 *   • fixed/split/decay — the flat (base) cap.
 *   • weekly_pooled     — the pool amortized to a daily share (÷7), so its
 *                         tightness/friction reflect the real per-day ceiling
 *                         (e.g. $250/wk ⇒ ~$35.71/day, tighter than baseline).
 *   • dynamic_segment   — the mean per-segment cap (a representative figure;
 *                         per-segment resolution lives in
 *                         {@link effectiveCapForSegment}).
 */
export function nominalCapUsd(cap: CapRule): number {
  switch (cap.kind) {
    case "fixed_window":
    case "split_window":
      return Math.max(0, finite(cap.capUsd));
    case "weekly_pooled":
      return Math.max(0, safeDiv(finite(cap.capUsd), WEEKLY_POOL_DAYS));
    case "progressive_decay":
      return Math.max(0, finite(cap.baseCapUsd));
    case "dynamic_segment": {
      const vals = SEGMENTS.map((s) => Math.max(0, finite(cap.perSegmentCapUsd[s.id])));
      const sum = vals.reduce((a, b) => a + b, 0);
      return safeDiv(sum, vals.length);
    }
  }
}

/**
 * How tight a cap is vs the baseline, as a 0-1 fraction where 0 = as loose as
 * (or looser than) the baseline and 1 = maximally tight. Combines two axes:
 *   • dollar lowness:  (BASELINE_CAP − cap$) / BASELINE_CAP, floored at 0.
 *   • window shortness: (BASELINE_WINDOW_H − windowH) / BASELINE_WINDOW_H.
 * The two are blended (max-dominant) so EITHER a much lower cap OR a much
 * shorter window registers as "tighter". Drives abuse capture (more capture
 * the tighter the policy).
 */
export function tightnessVsBaseline(cap: CapRule): number {
  const dollars = nominalCapUsd(cap);
  const windowH = capWindowHours(cap);

  const dollarLowness = clamp01(safeDiv(BASELINE_CAP_USD - dollars, BASELINE_CAP_USD));
  const windowShortness = clamp01(
    safeDiv(BASELINE_WINDOW_HOURS - windowH, BASELINE_WINDOW_HOURS),
  );

  // Max-dominant blend with a small additive contribution from the weaker
  // axis, so "$50/24h" and "$100/6h" both read as meaningfully tighter, and a
  // policy tight on BOTH axes ($50/6h) reads tighter still — but never > 1.
  const dominant = Math.max(dollarLowness, windowShortness);
  const weaker = Math.min(dollarLowness, windowShortness);
  return clamp01(dominant + weaker * (1 - dominant));
}

/**
 * Resolve the effective $ ceiling a given segment faces under a cap rule, for
 * a given claim index (0-based) and whether it is the first deposit of the
 * day. Centralizes EVERY cap shape:
 *   • fixed/split   — the flat cap (window length already affects velocity
 *                     elsewhere; the per-claim $ ceiling is the flat figure).
 *   • weekly_pooled — pooled cap amortized to ONE modeled window
 *                     (÷ WEEKLY_POOL_DAYS, since the window here is a day-ish
 *                     unit for per-claim comparison).
 *   • progressive_decay — base × (1 − decayPerClaim·claimIndex), floored.
 *   • dynamic_segment   — per-segment cap × first-of-day mult, then decayed
 *                         after `decayAfterNClaims`.
 */
export function effectiveCapForSegment(
  cap: CapRule,
  segmentId: SegmentId,
  isFirstDepositOfDay: boolean,
  claimIndex: number,
): number {
  const idx = Math.max(0, Math.floor(finite(claimIndex)));
  switch (cap.kind) {
    case "fixed_window":
    case "split_window":
      return Math.max(0, finite(cap.capUsd));
    case "weekly_pooled":
      // Pooled over a week → per-window (≈ per-day) allowance.
      return Math.max(0, safeDiv(finite(cap.capUsd), WEEKLY_POOL_DAYS));
    case "progressive_decay": {
      const decay = clamp01(cap.decayPerClaim);
      const decayed = finite(cap.baseCapUsd) * (1 - decay * idx);
      return Math.max(Math.max(0, finite(cap.floorCapUsd)), Math.max(0, decayed));
    }
    case "dynamic_segment": {
      const base = Math.max(0, finite(cap.perSegmentCapUsd[segmentId]));
      const fodMult = isFirstDepositOfDay
        ? Math.max(0, finite(cap.firstDepositOfDayBonusMult) || 1)
        : 1;
      const afterN = Math.max(0, Math.floor(finite(cap.decayAfterNClaims)));
      const extraClaims = Math.max(0, idx - afterN);
      const decay = clamp01(cap.decayPerClaim);
      const decayFactor = Math.max(0, 1 - decay * extraClaims);
      return Math.max(0, base * fodMult * decayFactor);
    }
  }
}

/** Clamp the avg bonus to the effective cap (a user can't claim above it). */
export function clampBonus(avgBonus: number, effectiveCap: number): number {
  const a = Math.max(0, finite(avgBonus));
  const c = Math.max(0, finite(effectiveCap));
  return Math.min(a, c);
}

/**
 * Number of cap WINDOWS that fit in the horizon — converts a per-window cap
 * to a horizon-total exposure. This is where "10/hr" vs "100/24h" diverge:
 * 1h windows give 24×/day of theoretical headroom vs 1×/day for a 24h window.
 * The raw headroom is later burst-damped for split caps so it does not blow
 * up linearly (real users don't max every hourly tranche).
 */
export function windowsInHorizon(cap: CapRule, days: number): number {
  const horizonHours = Math.max(0, finite(days)) * HOURS_PER_DAY;
  // Volume scales with CLAIM CADENCE, not cap-geometry window (so weekly_pooled
  // claims at a daily cadence, not once a week).
  const wh = claimCadenceHours(cap);
  return Math.max(1, safeDiv(horizonHours, wh));
}

/**
 * The horizon multiplier applied to per-window claim volume. Split caps with
 * many short windows get extra headroom but DAMPED (BURST_DAMPING) because
 * users don't actually saturate every tranche. Fixed/long windows pass through
 * at their natural per-day cadence.
 *
 * Normalized so the BASELINE (24h window) returns exactly `days` (one window
 * per day), making baseline volume independent of this multiplier.
 */
export function windowMultiplier(cap: CapRule, days: number): number {
  const windows = windowsInHorizon(cap, days);
  const baselineWindows = Math.max(1, finite(days)) * BASELINE_WINDOWS_PER_DAY;
  // Excess windows beyond the baseline cadence are damped.
  if (windows <= baselineWindows) return windows;
  const excess = windows - baselineWindows;
  return baselineWindows + excess * SPLIT_CAP_BURST_DAMPING;
}

/**
 * Burst-damping factor for the ABUSE-LEAKAGE channel specifically.
 *
 * Abuse thrives on velocity — rapid serial claiming inside a loose window.
 * Spacing the cap (split_window) structurally prevents that burst, so a spaced
 * cap leaks LESS abuse than the same dollars enforced in one long window. This
 * is the directional contract: "spaced/split caps multiply the burst component
 * of leakage by SPLIT_CAP_BURST_DAMPING (<1)".
 *
 * Crucially, abuse leakage is NOT scaled by the theoretical window count the
 * way cost is — finer windows do not hand an abuser more abuse opportunities
 * (their opportunity is bounded by deposit behaviour, not cap-slice count).
 * So leakage uses a baseline-cadence volume and applies THIS discount on top
 * for spaced caps. Returns 1.0 for fixed/long-window policies (no structural
 * burst suppression beyond their dollar/window tightness, already in capture).
 */
export function leakageBurstDamping(cap: CapRule): number {
  // Split windows tighter than the baseline cadence suppress bursts; the
  // shorter the window, the stronger the suppression (interpolated between
  // 1.0 at the baseline window and full BURST_DAMPING at the 1h floor).
  if (cap.kind !== "split_window") return 1;
  const wh = capWindowHours(cap);
  if (wh >= BASELINE_WINDOW_HOURS) return 1;
  const span = Math.max(EPSILON, BASELINE_WINDOW_HOURS - FRICTION_MIN_WINDOW_HOURS);
  const shortness = clamp01(safeDiv(BASELINE_WINDOW_HOURS - wh, span));
  // shortness 0 → factor 1; shortness 1 → factor SPLIT_CAP_BURST_DAMPING.
  return 1 - (1 - SPLIT_CAP_BURST_DAMPING) * shortness;
}

// ─── Friction ─────────────────────────────────────────────────────────────────

/**
 * UX friction composite, 0-100 (higher = worse). Weighted sum of:
 *   • window tightness — how much shorter than the reference window,
 *   • cap lowness      — how far below the baseline cap (over-generous adds 0),
 *   • decay penalty    — any decay-after-N rule adds its full weight.
 */
export function frictionScore(cap: CapRule): number {
  const windowH = capWindowHours(cap);
  // 0 at/above reference window, 1 at the 1h floor.
  const windowSpan = Math.max(EPSILON, FRICTION_REFERENCE_WINDOW_HOURS - FRICTION_MIN_WINDOW_HOURS);
  const windowTightness = clamp01(
    safeDiv(FRICTION_REFERENCE_WINDOW_HOURS - windowH, windowSpan),
  );

  const capLowness = clamp01(safeDiv(BASELINE_CAP_USD - nominalCapUsd(cap), BASELINE_CAP_USD));

  const hasDecay =
    cap.kind === "progressive_decay" ||
    (cap.kind === "dynamic_segment" && clamp01(cap.decayPerClaim) > 0);
  const decayPenalty = hasDecay ? 1 : 0;

  const raw =
    FRICTION_W_WINDOW_TIGHTNESS * windowTightness +
    FRICTION_W_CAP_LOWNESS * capLowness +
    FRICTION_W_DECAY * decayPenalty;

  return clamp(raw, 0, 100);
}

// ─── Per-segment economics ─────────────────────────────────────────────────────

/** How much of baseline abuse is CAPTURED (prevented) under a stricter cap. */
export function abuseCaptureUnderStricterCap(cap: CapRule, elasticity: number): number {
  return clamp01(clamp01(elasticity) * tightnessVsBaseline(cap));
}

/** How much legit conversion is LOST from tightening (the cost of capture). */
export function conversionLossFromTightening(cap: CapRule, sensitivity: number): number {
  return clamp01(clamp01(sensitivity) * tightnessVsBaseline(cap));
}

/**
 * Cannibalization fraction at a given nominal cap: a baseline rate that climbs
 * linearly once the cap exceeds the over-generous threshold (paying users who
 * would have deposited anyway).
 */
export function cannibalizationAtCap(cap: CapRule, baseRate: number): number {
  const over = Math.max(0, nominalCapUsd(cap) - OVERGENEROUS_CAP_THRESHOLD_USD);
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
 * Run the full forecast for one scenario.
 *
 * @param scenario   the cap policy to simulate
 * @param assumptions the behavioural / volume levers (sliders)
 * @param window     `{ days }` — horizon length; falls back to assumptions.windowDays
 */
export function simulate(
  scenario: ScenarioConfig,
  assumptions: Assumptions,
  window: { days: number },
): SimulationResult {
  const days = Math.max(1, finite(window.days) || finite(assumptions.windowDays) || 30);
  const cap = scenario.cap;

  const mix = normalizeSegmentMix(assumptions.segmentMix);
  const eligible = Math.max(0, finite(assumptions.eligibleUsers));
  const depositsPerWindow = Math.max(0, finite(assumptions.depositsPerUserPerWindow));
  const claimProb = clamp01(assumptions.claimProbability);
  const avgBonus = Math.max(0, finite(assumptions.avgBonusUsd));
  const breakage = clamp01(assumptions.breakageRate);
  const abuseShare = clamp01(assumptions.abuseShare);

  // Policy-derived scalars (computed once).
  const capture = abuseCaptureUnderStricterCap(cap, assumptions.abuseCaptureElasticity);
  const convLoss = conversionLossFromTightening(cap, assumptions.legitConversionSensitivity);
  const cannRate = cannibalizationAtCap(cap, assumptions.cannibalizationRate);
  const retentionUplift = Math.max(0, finite(assumptions.retentionUplift));

  // Volume: claimants over the horizon. Per window = eligible × deposits ×
  // P(claim). Scaled to the horizon by the (burst-damped) window multiplier.
  const claimantsPerWindow = eligible * depositsPerWindow * claimProb;
  const horizonClaimants = claimantsPerWindow * windowMultiplier(cap, days);

  // Abuse-leakage volume is scaled at the BASELINE cadence (one window/day),
  // NOT the policy's theoretical window count: finer cap slices do not create
  // more abuse opportunities. Spaced caps then get the burst-damping discount.
  const baselineCadenceClaimants =
    claimantsPerWindow * Math.max(1, days) * BASELINE_WINDOWS_PER_DAY;
  const leakDamping = leakageBurstDamping(cap);

  // The first deposit of any day enjoys the dynamic first-of-day multiplier;
  // model a representative fraction of claims as "first of day". For a 24h
  // window every claim is effectively a first-of-day; shorter windows dilute
  // it. claimIndex models serial claiming for the decay rules.
  const firstOfDayShare = clamp01(safeDiv(BASELINE_WINDOW_HOURS, claimCadenceHours(cap)));
  const representativeClaimIndex = Math.max(0, Math.round(depositsPerWindow));

  const perSegment: PerSegment[] = SEGMENTS.map((seg) => {
    const segFrac = mix[seg.id];
    const segClaimants = horizonClaimants * segFrac;

    // Effective cap blends a first-of-day claim and a later claim.
    const capFirst = effectiveCapForSegment(cap, seg.id, true, 0);
    const capLater = effectiveCapForSegment(cap, seg.id, false, representativeClaimIndex);
    const effectiveCapUsd = capFirst * firstOfDayShare + capLater * (1 - firstOfDayShare);

    const cappedBonus = clampBonus(avgBonus, effectiveCapUsd);

    // Bonus cost: claimants × per-claim capped bonus. Breakage does NOT reduce
    // cost (the bonus is still AWARDED/credited) — it reduces the wager that
    // backs downstream GGR (handled below). House-POV outflow.
    const segBonusCost = segClaimants * cappedBonus;

    // Abuse leakage: the abusive share of THIS segment's bonus, net of capture
    // and net of spaced-cap burst damping. High-risk segments carry their
    // baseline abuse share; others a fraction. Computed on the BASELINE-cadence
    // volume (so finer cap slices don't inflate abuse) × the per-claim capped
    // bonus the abuser pockets. Tighter caps reduce it via BOTH higher capture
    // AND (for spaced caps) the burst-damping discount.
    const segAbuseShare = seg.id === "high_risk_abuse" ? Math.max(abuseShare, 0) : abuseShare * 0.4;
    const segLeakClaimants = baselineCadenceClaimants * segFrac;
    const segAbuseLeakage =
      segLeakClaimants * cappedBonus * clamp01(segAbuseShare) * (1 - capture) * leakDamping;

    // Retained revenue: legit (non-abusive, non-cannibalized) bonus × uplift,
    // reduced by conversion lost to tightening. Only the WAGERED fraction of
    // the bonus (1 − breakage) can generate downstream play, so breakage
    // shrinks the retention base. Legit-heavy segments retain more.
    const legitShare = clamp01(1 - clamp01(segAbuseShare) - cannRate);
    const legitBonus = segBonusCost * legitShare * (1 - breakage);
    const segRetained = legitBonus * retentionUplift * (1 - convLoss);

    // NGR contribution, House-POV: downstream GGR proxy − bonus cost. The
    // modeled downstream accretion the bonus generates is the retained
    // revenue. Net of the bonus cost → NGR delta. Positive = NGR-accretive.
    const downstreamGgrProxy = segRetained;
    const segNgr = downstreamGgrProxy - segBonusCost;

    return {
      segment: seg.id,
      label: seg.label,
      claimants: finite(segClaimants),
      bonusCost: finite(segBonusCost),
      abuseLeakage: finite(segAbuseLeakage),
      retainedRevenue: finite(segRetained),
      ngrImpact: finite(segNgr),
      effectiveCapUsd: finite(effectiveCapUsd),
    };
  });

  // Aggregate.
  const bonusCost = perSegment.reduce((a, s) => a + s.bonusCost, 0);
  const abuseLeakage = perSegment.reduce((a, s) => a + s.abuseLeakage, 0);
  const retainedRevenue = perSegment.reduce((a, s) => a + s.retainedRevenue, 0);

  // NGR = downstream GGR proxy − bonusCost. Downstream GGR proxy = retained
  // revenue (the modeled accretive value the bonus generates). House-POV:
  // positive when retention beats cost.
  const ngrImpact = retainedRevenue - bonusCost;

  // Net house P&L attributable to the program = retained − cost − abuseLeakage
  // (abuse is pure leakage on top of cost). netLoss is its positive mirror.
  const marginImpact = retainedRevenue - bonusCost - abuseLeakage;
  const netLoss = Math.max(0, -marginImpact);

  const friction = frictionScore(cap);

  const confidenceBand = {
    low: bonusCost * (1 - CONFIDENCE_BAND_SPREAD),
    mid: bonusCost,
    high: bonusCost * (1 + CONFIDENCE_BAND_SPREAD),
  };

  // savings vs baseline are filled in by the caller-facing wrapper that knows
  // the baseline result; here we return them as 0 and let `simulateSet` patch
  // them. (A single simulate() can't know the baseline.) The daily series is
  // built against this scenario's own cost.
  const dailySeries = buildDailySeries(cap, days, {
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
 * Deterministic daily spread of a horizon total across `days`, using a pacing
 * curve (front-loaded for fixed-window, flat for split-window) that integrates
 * EXACTLY to the supplied totals (no drift). Accumulates `cumulativeCost`.
 */
export function buildDailySeries(
  cap: CapRule,
  days: number,
  totals: { bonusCost: number; abuseLeakage: number; savingsVsBaselineTotal: number },
): DailyPoint[] {
  const n = Math.max(1, Math.floor(finite(days)));
  const frontload =
    cap.kind === "split_window" || cap.kind === "weekly_pooled"
      ? SPLIT_WINDOW_FRONTLOAD
      : FIXED_WINDOW_FRONTLOAD;

  // Weight day i: linearly decaying from `frontload` down to a tail so the
  // mean weight is 1. For frontload=1 this is flat. Normalize to sum 1.
  const rawWeights: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0; // 0..1
    // weight starts at `frontload`, ends at (2 − frontload) so the average is 1.
    const w = frontload + (2 - frontload - frontload) * t; // = frontload − 2(frontload−1)t
    rawWeights.push(Math.max(0, w));
  }
  const weightSum = rawWeights.reduce((a, b) => a + b, 0) || 1;
  const weights = rawWeights.map((w) => w / weightSum);

  const out: DailyPoint[] = [];
  let cumulative = 0;
  for (let i = 0; i < n; i++) {
    const dayCost = finite(totals.bonusCost) * weights[i];
    const dayLeak = finite(totals.abuseLeakage) * weights[i];
    const daySavings = finite(totals.savingsVsBaselineTotal) * weights[i];
    cumulative += dayCost;
    out.push({
      day: i,
      bonusCost: dayCost,
      cumulativeCost: cumulative,
      savingsVsBaseline: daySavings,
      abuseLeakage: dayLeak,
    });
  }
  return out;
}

/**
 * Run a SET of scenarios and patch in savings-vs-baseline (gross + net) and
 * the daily savings series relative to the designated baseline scenario.
 *
 * @param scenarios    the scenarios to run (the first matching `baselineId`,
 *                     or the first entry, is the reference)
 * @param assumptions  shared levers
 * @param window       horizon
 * @param baselineId   id of the reference scenario (default: scenarios[0].id)
 */
export function simulateSet(
  scenarios: ScenarioConfig[],
  assumptions: Assumptions,
  window: { days: number },
  baselineId?: string,
): SimulationResult[] {
  if (scenarios.length === 0) return [];
  const refId = baselineId ?? scenarios[0].id;

  const raw = scenarios.map((sc) => ({ sc, res: simulate(sc, assumptions, window) }));
  const baseline = raw.find((r) => r.sc.id === refId)?.res ?? raw[0].res;
  const baseCost = baseline.bonusCost;

  const days = Math.max(1, finite(window.days) || finite(assumptions.windowDays) || 30);

  return raw.map(({ sc, res }) => {
    // GROSS savings = baseline cost − this cost (positive = cheaper).
    const savingsVsBaseline = baseCost - res.bonusCost;

    // NET savings subtracts the retained-revenue we GIVE UP by tightening
    // (baseline retention − this scenario's retention, when this is cheaper).
    // Tightening cuts cost but also cuts retained revenue → net < gross.
    const retentionGivenUp = Math.max(0, baseline.retainedRevenue - res.retainedRevenue);
    const netSavingsVsBaseline = savingsVsBaseline - retentionGivenUp;

    const dailySeries = buildDailySeries(sc.cap, days, {
      bonusCost: res.bonusCost,
      abuseLeakage: res.abuseLeakage,
      savingsVsBaselineTotal: savingsVsBaseline,
    });

    return {
      ...res,
      savingsVsBaseline: finite(savingsVsBaseline),
      netSavingsVsBaseline: finite(netSavingsVsBaseline),
      dailySeries,
    };
  });
}
