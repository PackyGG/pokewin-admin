/**
 * engine.ts — the GENERIC, reward-agnostic forecast orchestration.
 *
 * Side-effect-free, dep-free, primitives-only (mirrors `edge-calc/math.ts`).
 * Imports ONLY `constants.ts` + `types.ts`. No DB, no React, no Date, no RNG.
 * Safe to call from a server component, the client island's `useMemo`, a check
 * harness, or a future export — same numbers everywhere.
 *
 * This is the part of the deposit-bonus engine that is NOT specific to caps:
 *   • numeric guards (`clamp` / `clamp01` / `safeDiv` / `finite`),
 *   • `buildDailySeries` — deterministic daily spread that integrates EXACTLY
 *     to a total (front-load curve passed as a plain number, NOT a cap),
 *   • `scaleResultMoney` — uniform money rescale for real-baseline anchoring,
 *   • `simulateSet` — run a SET of scenarios, anchor on a real baseline total,
 *     and patch in savings-vs-baseline (gross + net) + the daily savings series.
 *
 * `simulateSet` is parameterized over the reward's PURE `simulate` fn and an
 * optional per-scenario `pacingFrontload`, so the SAME orchestration drives any
 * reward. The reward-specific cost / cap / leakage math lives in the reward's
 * own `_forecast/engine.ts` (its `simulate`), never here.
 *
 * ── House-POV ──────────────────────────────────────────────────────────────
 *   • `bonusCost` / `abuseLeakage` are house OUTFLOWS (render rose / amber).
 *   • positive `ngrImpact` / `netSavingsVsBaseline` = house GAIN (emerald).
 */

import { EPSILON, FLAT_FRONTLOAD } from "./constants";
import type {
  BaseAssumptions,
  BaseScenarioConfig,
  DailyPoint,
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
export function finite(x: number): number {
  return Number.isFinite(x) ? x : 0;
}

// ─── Daily series (deterministic, drift-free) ────────────────────────────────

/**
 * Deterministic daily spread of a horizon total across `days`, using a pacing
 * curve whose front-load is the supplied `frontload` (1 = flat, >1 = day-0
 * heavier). The weights are normalized to sum 1 and applied to EACH total, so
 * the series integrates EXACTLY to the supplied totals (no drift). Accumulates
 * `cumulativeCost`.
 *
 * Reward-agnostic: a reward decides its front-load (e.g. fixed-window caps
 * cluster claims early; spaced caps pace evenly) and passes the number — the
 * curve math is identical for every reward.
 */
export function buildDailySeries(
  frontload: number,
  days: number,
  totals: { bonusCost: number; abuseLeakage: number; savingsVsBaselineTotal: number },
): DailyPoint[] {
  const n = Math.max(1, Math.floor(finite(days)));
  const f = finite(frontload) || FLAT_FRONTLOAD;

  // Weight day i: linearly from `f` down to (2 − f) so the mean weight is 1.
  // For f=1 this is flat. Normalize to sum 1.
  const rawWeights: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0; // 0..1
    const w = f + (2 - f - f) * t; // = f − 2(f−1)t
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

// ─── Money rescale (real-baseline anchoring) ─────────────────────────────────

/**
 * Uniformly scale every MONEY field of a result by `scale` (claimant counts,
 * friction, effective caps and the dimensionless NGR/savings ratios are
 * preserved). Used to ANCHOR a whole set on a real baseline total without
 * distorting any relative ratio: scaling the baseline to the real cost scales
 * every other scenario by the same factor, so the savings RANKING and the
 * segment-cost composition are untouched and segment costs still sum to the
 * scenario total. Pure; `scale ≤ 0`, `=1`, or non-finite is a no-op.
 */
export function scaleResultMoney(res: SimulationResult, scale: number): SimulationResult {
  const k = finite(scale);
  if (!(k > 0) || k === 1) return res;
  return {
    ...res,
    bonusCost: finite(res.bonusCost * k),
    marginImpact: finite(res.marginImpact * k),
    netLoss: finite(res.netLoss * k),
    abuseLeakage: finite(res.abuseLeakage * k),
    retainedRevenue: finite(res.retainedRevenue * k),
    ngrImpact: finite(res.ngrImpact * k),
    confidenceBand: {
      low: finite(res.confidenceBand.low * k),
      mid: finite(res.confidenceBand.mid * k),
      high: finite(res.confidenceBand.high * k),
    },
    perSegment: res.perSegment.map((s) => ({
      ...s,
      // claimants & effectiveCapUsd are NOT money totals — leave them intact.
      bonusCost: finite(s.bonusCost * k),
      abuseLeakage: finite(s.abuseLeakage * k),
      retainedRevenue: finite(s.retainedRevenue * k),
      ngrImpact: finite(s.ngrImpact * k),
    })),
    // dailySeries is rebuilt from the scaled totals by the caller, so leave it.
    dailySeries: res.dailySeries,
  };
}

// ─── simulateSet — the generic orchestration ──────────────────────────────────

/** Options for {@link simulateSet}. */
export type SimulateSetOptions<S extends BaseScenarioConfig> = {
  /** Id of the reference (baseline) scenario (default: scenarios[0].id). */
  baselineId?: string;
  /** Optional real baseline total cost to anchor the whole set on. */
  anchorBaselineCostUsd?: number | null;
  /**
   * Per-scenario daily-pacing front-load (1 = flat). Used to rebuild the daily
   * series after savings are known. Defaults to flat (1) for every scenario.
   */
  pacingFrontload?: (scenario: S) => number;
};

/**
 * Run a SET of scenarios through the reward's PURE `simulate`, then:
 *   1. optionally ANCHOR the whole set so the BASELINE scenario's projected cost
 *      equals `anchorBaselineCostUsd` EXACTLY (uniform money scale — ratios and
 *      rankings unchanged), and
 *   2. patch in savings-vs-baseline (gross + net) and the daily savings series
 *      relative to the designated baseline scenario.
 *
 * GENERIC over the reward's assumptions `A` and scenario shape `S`. The reward
 * supplies its `simulate` fn; this function owns the cross-scenario anchoring +
 * savings bookkeeping that is identical for every reward.
 *
 * NET savings subtract the retained-revenue GIVEN UP by tightening (baseline
 * retention − this scenario's retention, floored at 0) — so net ≤ gross for
 * stricter scenarios. This is the honest "what we actually save" figure.
 *
 * @param scenarios   the scenarios to run
 * @param assumptions shared levers (a superset of {@link BaseAssumptions})
 * @param window      `{ days }` horizon
 * @param simulate    the reward's pure single-scenario engine
 * @param options     baseline id, real-cost anchor, and per-scenario pacing
 */
export function simulateSet<A extends BaseAssumptions, S extends BaseScenarioConfig>(
  scenarios: S[],
  assumptions: A,
  window: { days: number },
  simulate: (scenario: S, assumptions: A, window: { days: number }) => SimulationResult,
  options?: SimulateSetOptions<S>,
): SimulationResult[] {
  if (scenarios.length === 0) return [];
  const refId = options?.baselineId ?? scenarios[0].id;
  const pacingFrontload = options?.pacingFrontload;

  const rawResults = scenarios.map((sc) => ({ sc, res: simulate(sc, assumptions, window) }));
  const rawBaselineCost =
    (rawResults.find((r) => r.sc.id === refId)?.res ?? rawResults[0].res).bonusCost;

  // Anchor: scale the whole set so the baseline cost == the real total. Only
  // when a positive anchor AND a positive computed baseline both exist (else a
  // 0/0 would wipe the set) — otherwise keep the slider-derived scale.
  const anchor = finite(options?.anchorBaselineCostUsd ?? 0);
  const scale = anchor > 0 && rawBaselineCost > 0 ? anchor / rawBaselineCost : 1;
  const raw = rawResults.map(({ sc, res }) => ({ sc, res: scaleResultMoney(res, scale) }));

  const baseline = raw.find((r) => r.sc.id === refId)?.res ?? raw[0].res;
  const baseCost = baseline.bonusCost;

  const days = Math.max(1, finite(window.days) || finite(assumptions.windowDays) || 30);

  return raw.map(({ sc, res }) => {
    // GROSS savings = baseline cost − this cost (positive = cheaper).
    const savingsVsBaseline = baseCost - res.bonusCost;

    // NET savings subtracts the retained-revenue we GIVE UP by tightening.
    const retentionGivenUp = Math.max(0, baseline.retainedRevenue - res.retainedRevenue);
    const netSavingsVsBaseline = savingsVsBaseline - retentionGivenUp;

    const frontload = pacingFrontload ? finite(pacingFrontload(sc)) || FLAT_FRONTLOAD : FLAT_FRONTLOAD;
    const dailySeries = buildDailySeries(frontload, days, {
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
