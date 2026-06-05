/**
 * run.ts — self-checking assertions for the PURE rakeback forecast engine.
 *
 * The repo has no unit-test framework (only Playwright e2e under `e2e/`, which
 * `playwright.config.ts` scopes to `e2e/tests` — this file is NOT picked up by
 * it). Per CLAUDE.md, instead of adding a framework we pin the model with plain
 * `assert`-style checks, runnable on demand:
 *
 *   npx tsx "src/app/(admin)/insights/rewards/rakeback/_forecast/__checks__/run.ts"
 *
 * Exit code 0 = all checks passed; non-zero = a check failed (the message names
 * the failing case). It imports ONLY the pure engine modules — no DB, no React,
 * no server-only. `tsx` resolves the `@/` alias (used transitively by
 * `recommend.ts` → `@/lib/utils/format`) via tsconfig paths.
 *
 * What it pins (the rakeback directional contract):
 *   (a) Scenario A (baseline) has savingsVsBaseline === 0.
 *   (b) Every LOWER-RATE scenario has cost ≤ baseline cost (monotone in rate).
 *   (c) Every LOWER-RATE scenario leaks ≤ baseline farmed-wager leakage.
 *   (d) A slower cadence (weekly/monthly) raises breakage ⇒ lowers realized cost
 *       vs the same rate on a daily cadence.
 *   (e) An over-generous (> threshold) rate raises the farmed-wager share.
 *   (f) Every output is Number.isFinite (incl. degenerate all-zero inputs).
 *   (g) recommend() returns the 3 badges on distinct scenarios where possible.
 *
 * And the SCALE + RATE invariants:
 *   (S1) When anchored on a real baseline total, the baseline scenario's cost
 *        equals that anchor EXACTLY, and segment costs sum to it.
 *   (S2) A strictly-lower blended rate ⇒ cost ≤ baseline AND gross savings ≥ 0.
 *   (S3) A lower rate leaks ≤ the baseline's farmed-wager leakage.
 *   (S4) EVERY scenario's cost sits in a sane band of the baseline (0 ≤ cost ≤
 *        2× baseline — the most generous scenario, 10% dormant on a +elastic
 *        wager lift, is still well under the old kind of inversion).
 *   (S5) Every scenario's segment costs sum to that scenario's projected cost.
 *   (S6) A tiered policy gives whales a LOWER effective rate than small players.
 *   (S7) `effectiveBreakage` is monotone in cadence (daily < weekly < monthly)
 *        and the expiry component shortens-→-larger.
 */

import {
  BASELINE_CADENCE,
  BASELINE_RATE_FALLBACK,
  DEFAULT_BREAKAGE_RATE,
  DEFAULT_CLAIM_PROBABILITY,
  DEFAULT_DEPOSITS_PER_USER_PER_WINDOW,
  DEFAULT_FARM_CAPTURE_ELASTICITY,
  DEFAULT_FARMED_WAGER_SHARE,
  DEFAULT_RATE_CONVERSION_SENSITIVITY,
  DEFAULT_RETENTION_UPLIFT,
  DEFAULT_SEGMENT_MIX,
  DEFAULT_WAGER_ELASTICITY,
  DEFAULT_WINDOW_DAYS,
  OVERGENEROUS_RATE_THRESHOLD,
  SEGMENT_IDS,
} from "../constants";
import {
  blendedEffectiveRate,
  effectiveBreakage,
  effectiveRateForSegment,
  expiryBreakageComponent,
  farmedShareAtRate,
  normalizeSegmentMix,
  rateTightnessVsBaseline,
  simulateSet,
} from "../engine";
import { recommend } from "../../../../_forecast-engine";
import {
  BASELINE_SCENARIO_ID,
  RATE_WHATIF_SET,
  SCENARIO_A_BASELINE,
  SCENARIO_B_FLAT_3,
  SCENARIO_B_FLAT_4,
  SCENARIO_C_TIERED,
  SCENARIO_E_MONTHLY,
  SCENARIO_E_WEEKLY,
  SCENARIO_LIBRARY,
} from "../scenarios";
import {
  buildRakebackScenarios,
  realHeadlineRate,
  type RakebackBaselineExt,
  type RakebackCadenceConfig,
} from "../live-policy";
import type { Assumptions, ScenarioConfig, SimulationResult } from "../types";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(name);
    console.error(`  x ${name}`);
  }
}

// The default assumptions used across the checks. Volume is anchored to a real
// measured claimant count over a measured period; the blended rate + wager are
// the real anchors a flat-baseline policy reproduces. Representative figures:
// 20,000 claimants over 30 days, $40M wager at the 5% baseline rate.
const A: Assumptions = {
  baselineClaimants: 20000,
  baselinePeriodDays: 30,
  baselineClaimProbability: DEFAULT_CLAIM_PROBABILITY,
  segmentMix: DEFAULT_SEGMENT_MIX,
  baselineBlendedRate: BASELINE_RATE_FALLBACK,
  baselineWager: 40_000_000,
  depositsPerUserPerWindow: DEFAULT_DEPOSITS_PER_USER_PER_WINDOW,
  claimProbability: DEFAULT_CLAIM_PROBABILITY,
  avgBonusUsd: 100,
  breakageRate: DEFAULT_BREAKAGE_RATE,
  farmedWagerShare: DEFAULT_FARMED_WAGER_SHARE,
  farmCaptureElasticity: DEFAULT_FARM_CAPTURE_ELASTICITY,
  retentionUplift: DEFAULT_RETENTION_UPLIFT,
  rateConversionSensitivity: DEFAULT_RATE_CONVERSION_SENSITIVITY,
  wagerElasticity: DEFAULT_WAGER_ELASTICITY,
  windowDays: DEFAULT_WINDOW_DAYS,
};
const WINDOW = { days: DEFAULT_WINDOW_DAYS };

/** The real anchored baseline total cost (= wager × rate at the baseline). */
const REAL_TOTAL = A.baselineWager * A.baselineBlendedRate;

/**
 * A policy is "uniformly lower" when EVERY tier's effective rate is ≤ the
 * baseline rate. This — not a lower BLENDED rate — is the honest condition under
 * which a policy leaks ≤ baseline: farming is driven by each tier's OWN rate, so
 * a tiered policy that RAISES a low-value tier's rate (while cutting whales) has
 * a lower blended rate yet correctly farms MORE in that tier. The flat-trim
 * family (all tiers down) is uniformly lower; tiered-generous is not.
 */
function isUniformlyLowerRate(sc: ScenarioConfig): boolean {
  return SEGMENT_IDS.every(
    (id) => effectiveRateForSegment(sc.policy, id) <= A.baselineBlendedRate + 1e-12,
  );
}

function allFinite(r: SimulationResult): boolean {
  const scalars = [
    r.bonusCost,
    r.marginImpact,
    r.netLoss,
    r.savingsVsBaseline,
    r.netSavingsVsBaseline,
    r.abuseLeakage,
    r.retainedRevenue,
    r.ngrImpact,
    r.frictionScore,
    r.confidenceBand.low,
    r.confidenceBand.mid,
    r.confidenceBand.high,
  ];
  const segOk = r.perSegment.every(
    (s) =>
      Number.isFinite(s.claimants) &&
      Number.isFinite(s.bonusCost) &&
      Number.isFinite(s.abuseLeakage) &&
      Number.isFinite(s.retainedRevenue) &&
      Number.isFinite(s.ngrImpact) &&
      Number.isFinite(s.effectiveCapUsd),
  );
  const dailyOk = r.dailySeries.every(
    (d) =>
      Number.isFinite(d.bonusCost) &&
      Number.isFinite(d.cumulativeCost) &&
      Number.isFinite(d.savingsVsBaseline) &&
      Number.isFinite(d.abuseLeakage),
  );
  return scalars.every(Number.isFinite) && segOk && dailyOk;
}

// ─── (f) finiteness across the whole library + degenerate inputs ──────────────
console.log("\n[rakeback forecast checks] (f) every output is finite");
{
  const lib = simulateSet(SCENARIO_LIBRARY, A, WINDOW, BASELINE_SCENARIO_ID);
  check("all library results finite", lib.every(allFinite));
  const degenerate: Assumptions = {
    ...A,
    baselineClaimants: 0,
    baselineWager: 0,
    baselineBlendedRate: 0,
    avgBonusUsd: 0,
    depositsPerUserPerWindow: 0,
    segmentMix: { whales: 0, mid_volume: 0, low_volume: 0, dormant: 0 },
    windowDays: 0,
  };
  const deg = simulateSet(SCENARIO_LIBRARY, degenerate, { days: 0 }, BASELINE_SCENARIO_ID);
  check("degenerate (all-zero) inputs stay finite", deg.every(allFinite));
  check("degenerate baseline cost is 0 (no wager / no rate)", deg[0].bonusCost === 0);
}

// ─── (a) baseline savings === 0 ──────────────────────────────────────────────
console.log("[rakeback forecast checks] (a) baseline savingsVsBaseline === 0");
{
  const set = simulateSet(RATE_WHATIF_SET, A, WINDOW, BASELINE_SCENARIO_ID, REAL_TOTAL);
  const baseline = set.find((r) => r.scenarioId === BASELINE_SCENARIO_ID)!;
  check("baseline present in result set", !!baseline);
  check("baseline savingsVsBaseline === 0", baseline.savingsVsBaseline === 0);
  check("baseline netSavingsVsBaseline === 0", baseline.netSavingsVsBaseline === 0);
}

// ─── (b) lower-rate scenarios cost ≤ baseline ────────────────────────────────
console.log("[rakeback forecast checks] (b) lower rate ⇒ cost ≤ baseline (monotone)");
{
  const set = simulateSet(SCENARIO_LIBRARY, A, WINDOW, BASELINE_SCENARIO_ID, REAL_TOTAL);
  const byId = new Map(set.map((r) => [r.scenarioId, r]));
  const baseline = byId.get(BASELINE_SCENARIO_ID)!;
  const mix = normalizeSegmentMix(A.segmentMix);
  const lower = SCENARIO_LIBRARY.filter(
    (sc) =>
      rateTightnessVsBaseline(sc.policy, mix, A.baselineBlendedRate) > 1e-9 &&
      sc.id !== BASELINE_SCENARIO_ID,
  );
  check("there ARE lower-rate scenarios in the library", lower.length > 0);
  for (const sc of lower) {
    const r = byId.get(sc.id)!;
    check(
      `lower-rate "${sc.id}" costs ≤ baseline ($${r.bonusCost.toFixed(0)} ≤ $${baseline.bonusCost.toFixed(0)})`,
      r.bonusCost <= baseline.bonusCost + 1e-3,
    );
  }
  // Specific anchors: 3% flat is tighter than 4% flat → costs less.
  const r3 = byId.get(SCENARIO_B_FLAT_3.id)!;
  const r4 = byId.get(SCENARIO_B_FLAT_4.id)!;
  check("3% flat costs less than 4% flat (tighter rate)", r3.bonusCost < r4.bonusCost);
}

// ─── (c) uniformly-lower-rate scenarios leak ≤ baseline ──────────────────────
console.log("[rakeback forecast checks] (c) every-tier-lower rate ⇒ farmed-wager leakage ≤ baseline");
{
  const set = simulateSet(SCENARIO_LIBRARY, A, WINDOW, BASELINE_SCENARIO_ID, REAL_TOTAL);
  const byId = new Map(set.map((r) => [r.scenarioId, r]));
  const baseline = byId.get(BASELINE_SCENARIO_ID)!;
  const lower = SCENARIO_LIBRARY.filter(
    (sc) => isUniformlyLowerRate(sc) && sc.id !== BASELINE_SCENARIO_ID,
  );
  check("there ARE uniformly-lower-rate scenarios in the library", lower.length > 0);
  for (const sc of lower) {
    const r = byId.get(sc.id)!;
    check(
      `uniformly-lower "${sc.id}" leaks ≤ baseline ($${r.abuseLeakage.toFixed(0)} ≤ $${baseline.abuseLeakage.toFixed(0)})`,
      r.abuseLeakage <= baseline.abuseLeakage + 1e-3,
    );
  }
  // And the contrapositive (the honest economics): the balanced tiered policy
  // (C-tiered) has a LOWER BLENDED rate than baseline (whales trimmed pull the
  // blend down) yet leaks MORE — because it RAISES the low-value / dormant tier
  // rates above baseline, and farming tracks each tier's OWN rate. This is the
  // exact case the blended-only invariant got wrong; it is correct economics.
  const mix = normalizeSegmentMix(A.segmentMix);
  const tiered = SCENARIO_LIBRARY.find((sc) => sc.id === "C-tiered");
  if (tiered) {
    const rTiered = byId.get("C-tiered")!;
    const blendedTighter =
      rateTightnessVsBaseline(tiered.policy, mix, A.baselineBlendedRate) > 1e-9;
    const dormantOverBaseline =
      effectiveRateForSegment(tiered.policy, "dormant") > A.baselineBlendedRate;
    check("C-tiered has a LOWER blended rate than baseline (whales trimmed)", blendedTighter);
    check("C-tiered raises the dormant-tier rate ABOVE baseline (farming exposure)", dormantOverBaseline);
    check(
      `C-tiered leaks MORE than baseline despite a lower blended rate ($${rTiered.abuseLeakage.toFixed(0)} > $${baseline.abuseLeakage.toFixed(0)}) — farming tracks per-tier rate`,
      rTiered.abuseLeakage > baseline.abuseLeakage,
    );
  }
}

// ─── (d) slower cadence raises breakage ⇒ lowers realized cost ───────────────
console.log("[rakeback forecast checks] (d) slower cadence ⇒ more breakage ⇒ lower cost");
{
  // Same 5% rate, three cadences. Slower cadence forfeits more accrual.
  const set = simulateSet(
    [SCENARIO_A_BASELINE, SCENARIO_E_WEEKLY, SCENARIO_E_MONTHLY],
    A,
    WINDOW,
    BASELINE_SCENARIO_ID,
    REAL_TOTAL,
  );
  const daily = set.find((r) => r.scenarioId === SCENARIO_A_BASELINE.id)!;
  const weekly = set.find((r) => r.scenarioId === SCENARIO_E_WEEKLY.id)!;
  const monthly = set.find((r) => r.scenarioId === SCENARIO_E_MONTHLY.id)!;
  check(
    `weekly cost < daily cost (more breakage: $${weekly.bonusCost.toFixed(0)} < $${daily.bonusCost.toFixed(0)})`,
    weekly.bonusCost < daily.bonusCost,
  );
  check(
    `monthly cost < weekly cost (most breakage: $${monthly.bonusCost.toFixed(0)} < $${weekly.bonusCost.toFixed(0)})`,
    monthly.bonusCost < weekly.bonusCost,
  );
}

// ─── (e) over-generous rate raises farmed-wager share ────────────────────────
console.log("[rakeback forecast checks] (e) over-generous rate raises farmed share");
{
  const atThreshold = farmedShareAtRate(OVERGENEROUS_RATE_THRESHOLD, DEFAULT_FARMED_WAGER_SHARE);
  const over = farmedShareAtRate(0.15, DEFAULT_FARMED_WAGER_SHARE);
  check(
    `farmed share at 15% > at 10% threshold (${over.toFixed(3)} > ${atThreshold.toFixed(3)})`,
    over > atThreshold,
  );
  check(
    "farmed share at/below threshold equals the base rate",
    Math.abs(atThreshold - DEFAULT_FARMED_WAGER_SHARE) < 1e-9,
  );
  check("farmed share never exceeds 1", farmedShareAtRate(0.9, 0.9) <= 1);
}

// ─── confidence band brackets the base case ──────────────────────────────────
console.log("[rakeback forecast checks] confidence band brackets the base cost");
{
  const set = simulateSet(SCENARIO_LIBRARY, A, WINDOW, BASELINE_SCENARIO_ID, REAL_TOTAL);
  check(
    "every confidence band: low ≤ mid ≤ high",
    set.every((r) => r.confidenceBand.low <= r.confidenceBand.mid && r.confidenceBand.mid <= r.confidenceBand.high),
  );
  check(
    "confidence mid === bonusCost (band centered on the base case)",
    set.every((r) => Math.abs(r.confidenceBand.mid - r.bonusCost) < 1e-6),
  );
}

// ─── daily series integrates to the totals (no drift) ────────────────────────
console.log("[rakeback forecast checks] daily series sums back to the horizon totals");
{
  const set = simulateSet(SCENARIO_LIBRARY, A, WINDOW, BASELINE_SCENARIO_ID, REAL_TOTAL);
  for (const r of set) {
    const sumCost = r.dailySeries.reduce((a, d) => a + d.bonusCost, 0);
    check(
      `"${r.scenarioId}" daily bonusCost sums to total (${sumCost.toFixed(2)} ≈ ${r.bonusCost.toFixed(2)})`,
      Math.abs(sumCost - r.bonusCost) < 1e-2,
    );
    const lastCum = r.dailySeries[r.dailySeries.length - 1]?.cumulativeCost ?? 0;
    check(
      `"${r.scenarioId}" final cumulativeCost equals total`,
      Math.abs(lastCum - r.bonusCost) < 1e-2,
    );
  }
  check("daily series length === horizon days", set[0].dailySeries.length === DEFAULT_WINDOW_DAYS);
}

// ─── (g) recommend() returns the 3 badges on distinct scenarios ──────────────
console.log("[rakeback forecast checks] (g) recommend() emits 3 badges on distinct scenarios");
{
  const set = simulateSet(SCENARIO_LIBRARY, A, WINDOW, BASELINE_SCENARIO_ID, REAL_TOTAL);
  const recs = recommend(set);
  const badges = recs.map((r) => r.badge);
  check("recommend returns exactly 3 recommendations", recs.length === 3);
  check(
    "badges are highest-savings / lowest-friction / best-balance",
    badges.includes("highest-savings") && badges.includes("lowest-friction") && badges.includes("best-balance"),
  );
  const ids = new Set(recs.map((r) => r.scenarioId));
  check("recommendations land on distinct scenarios (full library)", ids.size === 3);
  check("every recommendation has a non-empty headline & detail", recs.every((r) => r.headline.length > 0 && r.detail.length > 0));
  check("recommend([]) returns []", recommend([]).length === 0);
}

// ════════════════════════════════════════════════════════════════════════════
// SCALE + RATE INVARIANTS
// ════════════════════════════════════════════════════════════════════════════

// ─── (S1)+(S4)+(S5)+(S2) — anchored what-if set ──────────────────────────────
console.log("[rakeback forecast checks] (S1/S2/S4/S5) anchored real-baseline what-if set");
{
  const set = simulateSet(RATE_WHATIF_SET, A, WINDOW, BASELINE_SCENARIO_ID, REAL_TOTAL);
  const baseline = set.find((r) => r.scenarioId === BASELINE_SCENARIO_ID)!;

  // (S1) baseline cost == the anchored real total, exactly (within float).
  check(
    `(S1) baseline cost == real total ($${baseline.bonusCost.toFixed(2)} ≈ $${REAL_TOTAL.toFixed(2)})`,
    Math.abs(baseline.bonusCost - REAL_TOTAL) < 1e-2,
  );

  const mix = normalizeSegmentMix(A.segmentMix);
  for (const r of set) {
    const ratio = baseline.bonusCost > 0 ? r.bonusCost / baseline.bonusCost : 0;
    // (S4) every scenario cost in a sane band of the baseline (0..2×). The
    // loosest what-if (7% flat, +elastic wager lift) is the high end.
    check(
      `(S4) "${r.scenarioId}" cost in 0–2× baseline (${ratio.toFixed(2)}×)`,
      r.bonusCost >= 0 && ratio <= 2.0,
    );
    // (S5) segment costs sum to the scenario total.
    const segSum = r.perSegment.reduce((a, s) => a + s.bonusCost, 0);
    check(
      `(S5) "${r.scenarioId}" segment costs sum to total ($${segSum.toFixed(2)} ≈ $${r.bonusCost.toFixed(2)})`,
      Math.abs(segSum - r.bonusCost) < 1e-2,
    );
    // (S2) lower-rate scenarios: cost ≤ baseline AND gross savings ≥ 0.
    const sc = RATE_WHATIF_SET.find((s) => s.id === r.scenarioId)!;
    const tighter = rateTightnessVsBaseline(sc.policy, mix, A.baselineBlendedRate) > 1e-9;
    if (tighter) {
      check(`(S2) "${r.scenarioId}" cost ≤ baseline (no inversion)`, r.bonusCost <= baseline.bonusCost + 1e-3);
      check(`(S2) "${r.scenarioId}" gross savings ≥ 0 ($${r.savingsVsBaseline.toFixed(0)})`, r.savingsVsBaseline >= -1e-3);
    }
  }
}

// ─── (S3) uniformly-lower rate leaks ≤ baseline (anchored) ───────────────────
console.log("[rakeback forecast checks] (S3) every-tier-lower rate ⇒ leakage ≤ baseline (anchored)");
{
  const set = simulateSet(SCENARIO_LIBRARY, A, WINDOW, BASELINE_SCENARIO_ID, REAL_TOTAL);
  const byId = new Map(set.map((r) => [r.scenarioId, r]));
  const baseline = byId.get(BASELINE_SCENARIO_ID)!;
  const lower = SCENARIO_LIBRARY.filter(
    (sc) => isUniformlyLowerRate(sc) && sc.id !== BASELINE_SCENARIO_ID,
  );
  for (const sc of lower) {
    const r = byId.get(sc.id)!;
    check(
      `(S3) uniformly-lower "${sc.id}" leaks ≤ baseline ($${r.abuseLeakage.toFixed(0)} ≤ $${baseline.abuseLeakage.toFixed(0)})`,
      r.abuseLeakage <= baseline.abuseLeakage + 1e-3,
    );
  }
}

// ─── (S6) tiered policy: whales get a lower rate than small players ──────────
console.log("[rakeback forecast checks] (S6) tiered policy taper-by-wager");
{
  const whaleRate = effectiveRateForSegment(SCENARIO_C_TIERED.policy, "whales");
  const lowRate = effectiveRateForSegment(SCENARIO_C_TIERED.policy, "low_volume");
  const dormantRate = effectiveRateForSegment(SCENARIO_C_TIERED.policy, "dormant");
  check(
    `(S6) tiered: whales rate < low-volume rate (${(whaleRate * 100).toFixed(1)}% < ${(lowRate * 100).toFixed(1)}%)`,
    whaleRate < lowRate,
  );
  check(
    `(S6) tiered: low-volume rate < dormant rate (${(lowRate * 100).toFixed(1)}% < ${(dormantRate * 100).toFixed(1)}%)`,
    lowRate < dormantRate,
  );
  // The blended effective rate of the tiered policy under the wager mix.
  const blended = blendedEffectiveRate(SCENARIO_C_TIERED.policy, normalizeSegmentMix(A.segmentMix));
  check("(S6) tiered blended rate is positive & finite", blended > 0 && Number.isFinite(blended));
}

// ─── (S7) effectiveBreakage monotone in cadence; expiry shortens→larger ──────
console.log("[rakeback forecast checks] (S7) breakage monotone in cadence / expiry");
{
  const dailyB = effectiveBreakage({ kind: "flat_rate", rate: 0.05, cadence: "daily" }, DEFAULT_BREAKAGE_RATE);
  const weeklyB = effectiveBreakage({ kind: "cadence_gated", rate: 0.05, cadence: "weekly" }, DEFAULT_BREAKAGE_RATE);
  const monthlyB = effectiveBreakage({ kind: "cadence_gated", rate: 0.05, cadence: "monthly" }, DEFAULT_BREAKAGE_RATE);
  check(`(S7) breakage daily < weekly (${dailyB.toFixed(3)} < ${weeklyB.toFixed(3)})`, dailyB < weeklyB);
  check(`(S7) breakage weekly < monthly (${weeklyB.toFixed(3)} < ${monthlyB.toFixed(3)})`, weeklyB < monthlyB);
  // Expiry: a shorter expiry adds a larger breakage component.
  const exp7 = expiryBreakageComponent({ kind: "expiry_capped", rate: 0.05, cadence: "daily", expiryDays: 7 });
  const exp14 = expiryBreakageComponent({ kind: "expiry_capped", rate: 0.05, cadence: "daily", expiryDays: 14 });
  check(`(S7) 7d expiry breakage > 14d (${exp7.toFixed(3)} > ${exp14.toFixed(3)})`, exp7 > exp14);
  check("(S7) non-expiry policy has zero expiry breakage", expiryBreakageComponent({ kind: "flat_rate", rate: 0.05, cadence: "daily" }) === 0);
  // Baseline (daily, no expiry) breakage equals the slider × the daily mult.
  check("(S7) baseline cadence is daily", BASELINE_CADENCE === "daily");
}

// ════════════════════════════════════════════════════════════════════════════
// LIVE-POLICY BUILDER (the real-config fix — what the owner caught)
// ════════════════════════════════════════════════════════════════════════════

// The REAL production rakeback policy: three per-cadence programs (NOT a flat
// 5%). These are the actual configured rates the owner cited.
const REAL_CADENCES: RakebackCadenceConfig[] = [
  { cadence: "daily", rate: 0.0025, expiryDays: 5, enabled: true },
  { cadence: "weekly", rate: 0.001, expiryDays: 7, enabled: true },
  { cadence: "monthly", rate: 0.0005, expiryDays: 14, enabled: true },
];
const REAL_HEADLINE = 0.0025 + 0.001 + 0.0005; // 0.40%
// A measured blended rate distinct from the headline (rakeback ÷ wager) — the
// anchor the baseline reproduces.
const MEASURED_BLENDED = 0.0032;

function liveBaseline(over: Partial<RakebackBaselineExt> = {}): RakebackBaselineExt {
  return {
    totalCost: 50_000,
    uniqueClaimants: 8_000,
    periodDays: 30,
    claimProbability: null,
    avgBonusUsd: 6.25,
    empiricalCapUsd: 900,
    capHitRate: null,
    blendedRoi: 2.1,
    avgGgrPerClaimant: 40,
    blendedRate: MEASURED_BLENDED,
    totalWager: 50_000 / MEASURED_BLENDED,
    cadenceConfig: REAL_CADENCES,
    ...over,
  };
}

/**
 * The assumptions the live builder's scenarios run against — the engine
 * reference rate (`baselineBlendedRate`) + wager (`baselineWager`) are the REAL
 * measured anchors (matching `liveBaseline()`), so the live baseline scenario's
 * modeled rate == `baselineBlendedRate` (tightness 0) and the anchor reproduces
 * the real total. The behavioural levers stay at their named defaults.
 */
function liveBaselineAssumptions(): Assumptions {
  return {
    ...A,
    baselineClaimants: 8_000,
    baselinePeriodDays: 30,
    baselineBlendedRate: MEASURED_BLENDED,
    baselineWager: 50_000 / MEASURED_BLENDED,
    avgBonusUsd: 6.25,
  };
}

console.log("[rakeback forecast checks] (L) live builder reflects the REAL per-cadence policy");
{
  // realHeadlineRate sums only the enabled cadences.
  check(
    `(L) realHeadlineRate == Σ enabled cadence rates (${(REAL_HEADLINE * 100).toFixed(2)}%)`,
    Math.abs(realHeadlineRate(REAL_CADENCES) - REAL_HEADLINE) < 1e-12,
  );
  check(
    "(L) a disabled cadence is excluded from the headline",
    Math.abs(
      realHeadlineRate([
        { cadence: "daily", rate: 0.0025, expiryDays: 5, enabled: true },
        { cadence: "weekly", rate: 0.001, expiryDays: 7, enabled: false },
      ]) - 0.0025,
    ) < 1e-12,
  );

  const built = buildRakebackScenarios(liveBaseline());
  check("(L) builder returns a live set when real config is present", built != null);

  if (built) {
    const { scenarios, whatifSet, baselineScenarioId } = built;
    check("(L) baseline id is A-baseline", baselineScenarioId === "A-baseline");
    const base = scenarios.find((s) => s.id === baselineScenarioId)!;
    check("(L) baseline present", !!base);

    // The baseline must NOT model a fabricated flat 5% — it must model the REAL
    // measured blended rate (≈0.32%), which is what the owner's fix demands.
    check(
      `(L) baseline modeled rate == real measured blended (${(MEASURED_BLENDED * 100).toFixed(2)}%), NOT 5%`,
      base.policy.kind === "flat_rate" &&
        Math.abs(base.policy.rate - MEASURED_BLENDED) < 1e-12 &&
        base.policy.rate < 0.05,
    );
    // The baseline label/description must surface the real per-cadence policy.
    check(
      "(L) baseline description names the real cadences (Daily/Weekly/Monthly + %)",
      /Daily 0\.25%/.test(base.description) &&
        /Weekly 0\.1%/.test(base.description) &&
        /Monthly 0\.05%/.test(base.description),
    );
    check(
      "(L) NO scenario is labeled a flat 3–7% (the fabricated gradient is gone)",
      !scenarios.some((s) => /Flat [3-7]%/.test(s.label)),
    );

    // Anchor + monotonicity through the real engine: baseline reproduces the
    // real total; every what-if that lowers the headline rate costs ≤ baseline.
    const set = simulateSet(scenarios, liveBaselineAssumptions(), WINDOW, baselineScenarioId, 50_000);
    const baseRes = set.find((r) => r.scenarioId === baselineScenarioId)!;
    check(
      `(L) baseline cost == real total ($${baseRes.bonusCost.toFixed(0)} ≈ $50000)`,
      Math.abs(baseRes.bonusCost - 50_000) < 1e-2,
    );
    check("(L) baseline savingsVsBaseline == 0", Math.abs(baseRes.savingsVsBaseline) < 1e-6);

    // A "trim the daily cadence −50%" what-if must cost strictly less than baseline.
    const trim = set.find((r) => /B-trim-daily-50/.test(r.scenarioId));
    check("(L) a daily −50% trim what-if exists", !!trim);
    if (trim) {
      check(
        `(L) daily −50% trim costs < baseline ($${trim.bonusCost.toFixed(0)} < $${baseRes.bonusCost.toFixed(0)})`,
        trim.bonusCost < baseRes.bonusCost,
      );
      check(`(L) daily −50% trim gross savings ≥ 0`, trim.savingsVsBaseline >= -1e-3);
    }
    // A "daily only" what-if (drop weekly+monthly) must be the leanest rate move.
    const dailyOnly = set.find((r) => r.scenarioId === "C-daily-only");
    check("(L) daily-only what-if exists (multi-cadence policy)", !!dailyOnly);
    if (dailyOnly) {
      check(
        `(L) daily-only costs < baseline ($${dailyOnly.bonusCost.toFixed(0)} < $${baseRes.bonusCost.toFixed(0)})`,
        dailyOnly.bonusCost < baseRes.bonusCost,
      );
    }
    // Every live result must be finite + segment-summed.
    check("(L) every live result is finite", set.every(allFinite));
    for (const r of set) {
      const segSum = r.perSegment.reduce((a, s) => a + s.bonusCost, 0);
      check(
        `(L) "${r.scenarioId}" segment costs sum to total`,
        Math.abs(segSum - r.bonusCost) < 1e-2,
      );
    }
    // The what-if comparison set is the baseline + the realistic rate moves.
    check("(L) whatifSet starts at the baseline", whatifSet[0]?.id === baselineScenarioId);
    check("(L) whatifSet has at least 3 rows", whatifSet.length >= 3);
  }

  // No real config threaded → builder returns null (caller falls back to static).
  check(
    "(L) builder returns null with no cadence config",
    buildRakebackScenarios(liveBaseline({ cadenceConfig: undefined })) === null,
  );
  check(
    "(L) builder returns null when all cadences disabled",
    buildRakebackScenarios(
      liveBaseline({
        cadenceConfig: REAL_CADENCES.map((c) => ({ ...c, enabled: false })),
      }),
    ) === null,
  );
}

// ─── summary ─────────────────────────────────────────────────────────────────
console.log(`\n[rakeback forecast checks] ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`\nFAILED checks:\n  - ${failures.join("\n  - ")}\n`);
  process.exit(1);
}
console.log("[rakeback forecast checks] OK — all directional invariants hold.\n");
