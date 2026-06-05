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
// The GENERIC numeric guards + orchestration now live in the shared engine kit.
// Deposit-bonus re-exports the guards (so its `index.ts` surface is unchanged)
// and wraps the generic `simulateSet` / `buildDailySeries` / `scaleResultMoney`
// with its cap-aware signatures (so `__checks__/run.ts` keeps working verbatim).
import {
  buildDailySeries as buildDailySeriesGeneric,
  clamp,
  clamp01,
  finite,
  safeDiv,
  scaleResultMoney,
  simulateSet as simulateSetGeneric,
} from "../../../_forecast-engine";

// Re-export the shared numeric guards under the deposit-bonus engine surface so
// existing imports (`./engine` → recommend.ts, index.ts barrel) stay valid.
export { clamp, clamp01, safeDiv, scaleResultMoney };

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
 * How many cap windows reset in a day for this rule (`24 / windowHours`),
 * clamped ≥1. A 24h window → 1/day; a 6h window → 4/day; a 1h window → 24/day.
 * weekly_pooled has no daily reset wall (the ceiling is the weekly pool), so it
 * reports the baseline cadence (1/day) — its real per-day allowance is handled
 * by amortizing the pool in {@link effectiveDailyCeilingUsd}.
 */
export function windowsPerDay(cap: CapRule): number {
  if (cap.kind === "weekly_pooled") return BASELINE_WINDOWS_PER_DAY;
  const wh = capWindowHours(cap);
  return Math.max(1, safeDiv(HOURS_PER_DAY, wh));
}

/**
 * The EFFECTIVE DAILY-EQUIVALENT CEILING ($) — the most a realistically-
 * depositing user can actually pull under this policy in a single day.
 *
 * This is the crux of the cost model (see `EFFECTIVE_CEILING_MODEL` in
 * constants): a per-window dollar cap only bites to the extent a user has
 * deposits to spend it on. A 1h window theoretically allows 24 tranches/day,
 * but a user depositing `depositsPerDay` times can fill at most that many —
 * so the daily ceiling is `perWindowCap × min(depositsPerDay, windowsPerDay)`,
 * NOT `perWindowCap × windowsPerDay`. This is why a $10/1h cap is FAR tighter
 * than $100/24h for a ~1.4-deposit/day user (~$14/day vs $100/day), and why
 * shrinking the window LOWERS the effective ceiling instead of inflating cost.
 *
 *   • fixed/split        — capUsd × min(depositsPerDay, windowsPerDay).
 *   • weekly_pooled      — min(pool ÷ 7 [amortized daily share],
 *                              perDayCeiling at a daily cadence). The pool is
 *                              the binding wall when it is tighter than the
 *                              daily fill.
 *   • progressive_decay  — base cap × deposits (the first claim is generous,
 *                          later same-day claims decay — captured via the
 *                          representative effective cap elsewhere); the daily
 *                          ceiling uses the base cap × min(deposits, 1) since a
 *                          24h decay window resets daily.
 *   • dynamic_segment    — mean per-segment cap × min(deposits, windowsPerDay).
 *
 * Always ≥0 and finite.
 */
export function effectiveDailyCeilingUsd(cap: CapRule, depositsPerDay: number): number {
  const deposits = Math.max(0, finite(depositsPerDay));
  const wpd = windowsPerDay(cap);
  const fillsPerDay = Math.min(deposits, wpd);
  switch (cap.kind) {
    case "fixed_window":
    case "split_window":
      return Math.max(0, finite(cap.capUsd)) * fillsPerDay;
    case "weekly_pooled": {
      const dailyAmortized = Math.max(0, safeDiv(finite(cap.capUsd), WEEKLY_POOL_DAYS));
      // The per-claim ceiling at a daily cadence is the amortized share; a user
      // can fill it across `min(deposits, 1)` daily windows. The pool itself is
      // the wall, so the daily-equivalent ceiling is the amortized daily share.
      return dailyAmortized * Math.min(deposits, BASELINE_WINDOWS_PER_DAY) || dailyAmortized;
    }
    case "progressive_decay":
      // 24h-style decay window resets daily; the first (generous) base claim
      // dominates the daily ceiling. Later same-day claims decay (modeled in
      // the representative effective cap), so the daily ceiling uses the base.
      return Math.max(0, finite(cap.baseCapUsd)) * Math.min(deposits, windowsPerDay(cap));
    case "dynamic_segment": {
      const vals = SEGMENTS.map((s) => Math.max(0, finite(cap.perSegmentCapUsd[s.id])));
      const meanCap = safeDiv(vals.reduce((a, b) => a + b, 0), vals.length);
      return meanCap * fillsPerDay;
    }
  }
}

/**
 * Per-SEGMENT effective daily-equivalent ceiling — like
 * {@link effectiveDailyCeilingUsd} but resolving the dynamic_segment per-segment
 * cap for one segment (other rules are segment-agnostic, so they fall through to
 * the same value). Lets the dynamic policy give low-risk segments a high daily
 * ceiling (retention) and high-risk segments a tiny one (kills leakage).
 */
export function effectiveDailyCeilingForSegment(
  cap: CapRule,
  segmentId: SegmentId,
  depositsPerDay: number,
): number {
  if (cap.kind !== "dynamic_segment") return effectiveDailyCeilingUsd(cap, depositsPerDay);
  const deposits = Math.max(0, finite(depositsPerDay));
  const fillsPerDay = Math.min(deposits, windowsPerDay(cap));
  const segCap = Math.max(0, finite(cap.perSegmentCapUsd[segmentId]));
  return segCap * fillsPerDay;
}

/**
 * Monotone, concave PAYOUT-RETENTION FACTOR (0-1) for a daily-equivalent
 * ceiling vs the baseline ceiling. Models how much of the average paid bonus
 * SURVIVES once a tighter cap truncates the upper tail of the bonus
 * distribution. Derived as the mean of `min(x, c)` for x ~ Uniform[0, B]
 * divided by the untruncated mean (B/2):
 *
 *   r = clamp01(ceiling / baselineCeiling)
 *   factor = 2r − r²
 *
 * factor(1) = 1 (at/above baseline → no truncation), factor(0) = 0, strictly
 * increasing and concave in between, so moderate trims bite modestly and
 * aggressive caps bite hard — but the factor never exceeds 1, so a policy can
 * never cost MORE than the baseline through this channel.
 */
export function payoutRetentionFromCeiling(ceiling: number, baselineCeiling: number): number {
  const r = clamp01(safeDiv(Math.max(0, finite(ceiling)), Math.max(0, finite(baselineCeiling))));
  return clamp01(2 * r - r * r);
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
  // `depositsPerUserPerWindow` is anchored to the BASELINE (24h) window, i.e. a
  // PER-DAY deposit frequency — a property of the user, not the cap geometry.
  // Volume must NOT scale with how many cap windows fit the horizon.
  const depositsPerDay = Math.max(0, finite(assumptions.depositsPerUserPerWindow));
  const avgBonus = Math.max(0, finite(assumptions.avgBonusUsd));
  const breakage = clamp01(assumptions.breakageRate);
  const abuseShare = clamp01(assumptions.abuseShare);

  // Policy-derived scalars (computed once).
  const capture = abuseCaptureUnderStricterCap(cap, assumptions.abuseCaptureElasticity);
  const convLoss = conversionLossFromTightening(cap, assumptions.legitConversionSensitivity);
  const cannRate = cannibalizationAtCap(cap, assumptions.cannibalizationRate);
  const retentionUplift = Math.max(0, finite(assumptions.retentionUplift));

  // ── Volume — anchored to the REAL measured claimant count, identical across
  // every policy ──
  // Claims over the horizon = real claimants (measured over `baselinePeriodDays`)
  // linearly scaled to the forecast horizon, then modulated by the claim-
  // probability lever RELATIVE to its real measured default. At the default
  // lever the modulation is 1.0, so the volume is exactly the real count scaled
  // to the horizon; moving the slider explores a higher / lower claim rate.
  // This is the SAME for every cap rule: shrinking the cap window does not
  // create more claims (a user deposits at their own cadence, not the cap's).
  const baselineClaimants = Math.max(0, finite(assumptions.baselineClaimants));
  const baselinePeriodDays = Math.max(1, finite(assumptions.baselinePeriodDays));
  const claimProb = clamp01(assumptions.claimProbability);
  const baseClaimProb = clamp01(assumptions.baselineClaimProbability);
  // Normalize the lever against its real default (default ⇒ 1.0). When the real
  // ratio is ~0 (no measured baseline), fall back to using the lever directly so
  // the slider still has an effect instead of collapsing volume to 0.
  const claimProbFactor = baseClaimProb > EPSILON ? claimProb / baseClaimProb : claimProb;
  const horizonClaimants =
    baselineClaimants * (Math.max(1, days) / baselinePeriodDays) * claimProbFactor;

  // ── Effective-ceiling truncation — where policies actually diverge on cost ──
  // The baseline daily-equivalent ceiling (the reference for payout retention).
  const baselineDailyCeiling = BASELINE_CAP_USD * Math.min(depositsPerDay, BASELINE_WINDOWS_PER_DAY);
  // Spaced caps suppress burst abuse on top of the dollar/window tightness.
  const leakDamping = leakageBurstDamping(cap);

  // The first deposit of any day enjoys the dynamic first-of-day multiplier;
  // model a representative fraction of claims as "first of day". For a 24h
  // window every claim is effectively a first-of-day; shorter windows dilute
  // it. claimIndex models serial claiming for the decay rules.
  const firstOfDayShare = clamp01(safeDiv(BASELINE_WINDOW_HOURS, claimCadenceHours(cap)));
  const representativeClaimIndex = Math.max(0, Math.round(depositsPerDay));

  const perSegment: PerSegment[] = SEGMENTS.map((seg) => {
    const segFrac = mix[seg.id];
    const segClaimants = horizonClaimants * segFrac;

    // Per-claim HARD ceiling (binds when the avg bonus exceeds the cap): blends
    // a first-of-day claim and a later claim. Kept so the dynamic per-segment
    // caps still differentiate segments and a high avg bonus is clamped.
    const capFirst = effectiveCapForSegment(cap, seg.id, true, 0);
    const capLater = effectiveCapForSegment(cap, seg.id, false, representativeClaimIndex);
    const effectiveCapUsd = capFirst * firstOfDayShare + capLater * (1 - firstOfDayShare);
    const hardClamped = clampBonus(avgBonus, effectiveCapUsd);

    // Per-claim PAID bonus = hard-clamped average, reduced by the distribution-
    // tail truncation a tighter daily-equivalent ceiling imposes. This is the
    // channel that makes a lower ceiling cost LESS even when the avg bonus sits
    // below every nominal cap (the real-baseline case: ~$4.22 avg, $100 cap).
    // High-risk segments under the dynamic policy get a tiny ceiling → strong
    // truncation; low-risk segments keep a generous ceiling → ~no truncation.
    const segDailyCeiling = effectiveDailyCeilingForSegment(cap, seg.id, depositsPerDay);
    const payoutFactor = payoutRetentionFromCeiling(segDailyCeiling, baselineDailyCeiling);
    const paidBonus = hardClamped * payoutFactor;

    // Bonus cost: claimants × per-claim PAID bonus. Breakage does NOT reduce
    // cost (the bonus is still AWARDED/credited) — it reduces the wager that
    // backs downstream GGR (handled below). House-POV outflow.
    const segBonusCost = segClaimants * paidBonus;

    // Abuse leakage: the abusive share of THIS segment's PAID bonus, net of
    // capture and net of spaced-cap burst damping. High-risk segments carry
    // their baseline abuse share; others a fraction. Volume is the SAME
    // behaviour-bounded claimant count (finer cap slices do not hand an abuser
    // more opportunities). Tighter caps reduce leakage via THREE reinforcing
    // channels: a lower paid bonus, higher capture, and (for spaced caps) the
    // burst-damping discount — so it is monotone-decreasing in tightness.
    const segAbuseShare = seg.id === "high_risk_abuse" ? Math.max(abuseShare, 0) : abuseShare * 0.4;
    const segAbuseLeakage =
      segClaimants * paidBonus * clamp01(segAbuseShare) * (1 - capture) * leakDamping;

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
 * The daily-pacing FRONT-LOAD factor a cap rule implies: fixed-window caps
 * cluster claims early (front-loaded), split / weekly-pooled caps pace evenly
 * (flat). This is the deposit-bonus mapping of a cap → the generic pacing
 * number the shared `buildDailySeries` consumes.
 */
export function capFrontload(cap: CapRule): number {
  return cap.kind === "split_window" || cap.kind === "weekly_pooled"
    ? SPLIT_WINDOW_FRONTLOAD
    : FIXED_WINDOW_FRONTLOAD;
}

/**
 * Deterministic daily spread of a horizon total across `days`, using a pacing
 * curve (front-loaded for fixed-window, flat for split-window) that integrates
 * EXACTLY to the supplied totals (no drift). Accumulates `cumulativeCost`.
 *
 * Thin cap-aware wrapper over the shared `buildDailySeries` (which takes the
 * front-load as a plain number) — kept with the cap signature so `simulate` and
 * the engine self-checks (`__checks__/run.ts`) call it unchanged.
 */
export function buildDailySeries(
  cap: CapRule,
  days: number,
  totals: { bonusCost: number; abuseLeakage: number; savingsVsBaselineTotal: number },
): DailyPoint[] {
  return buildDailySeriesGeneric(capFrontload(cap), days, totals);
}

/**
 * Run a SET of scenarios and patch in savings-vs-baseline (gross + net) and
 * the daily savings series relative to the designated baseline scenario.
 *
 * When `anchorBaselineCostUsd` is supplied (the REAL production total bonus
 * cost), the whole set is uniformly scaled so the BASELINE scenario's projected
 * cost equals that anchor EXACTLY — every view (KPI, table, charts, segment
 * bars) then reads the real baseline, and other scenarios stay coherent
 * fractions/multiples of it (their cost ÷ ceiling ratios are unchanged by a
 * uniform scale). Omit the anchor (or pass null) to keep the slider-derived
 * absolute scale.
 *
 * Thin cap-aware wrapper over the shared, reward-agnostic `simulateSet`: it
 * supplies deposit-bonus's pure `simulate` + the cap→front-load pacing resolver
 * and preserves the original 5-arg signature so the live page and the engine
 * self-checks call it unchanged.
 *
 * @param scenarios    the scenarios to run (the first matching `baselineId`,
 *                     or the first entry, is the reference)
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
    pacingFrontload: (sc) => capFrontload(sc.cap),
  });
}
