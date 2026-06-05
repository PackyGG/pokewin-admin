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
 *
 * And the MULTI-CADENCE + PRE-CLAIM enhancements:
 *   (M1) `multiCadenceHeadlineRate` == Σ of the three per-cadence rates; the
 *        multi_cadence policy's effective rate is that sum, flat across segments.
 *   (M2) Combined-cadence trims cost ≤ baseline, deeper = cheaper, all finite +
 *        segment-summed.
 *   (P1) `preClaimCostFactor` == α·discount + (1−α)·(1−breakage); the saving ==
 *        α·[(1−breakage) − discount]; adoption 0 is inert; a discount above the
 *        normal payout is a cost (negative saving).
 *   (P2) The "Pre-claim @ 65%" scenario nets savings vs baseline at the default
 *        discount, same friction as baseline (same policy), finite + summed.
 *   (P3) The pre-claim levers ONLY bite on opt-in scenarios — the baseline cost
 *        is invariant to the sliders; the pre-claim scenario responds to them.
 */

import {
  BASELINE_CADENCE,
  BASELINE_RATE_FALLBACK,
  DEFAULT_BREAKAGE_RATE,
  DEFAULT_CLAIM_PROBABILITY,
  DEFAULT_DEPOSITS_PER_USER_PER_WINDOW,
  DEFAULT_FARM_CAPTURE_ELASTICITY,
  DEFAULT_FARMED_WAGER_SHARE,
  DEFAULT_PRE_CLAIM_ADOPTION,
  DEFAULT_PRE_CLAIM_DISCOUNT,
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
  multiCadenceHeadlineRate,
  normalizeSegmentMix,
  preClaimCostFactor,
  preClaimSavingPerAccrual,
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
  SCENARIO_F_ALL_MINUS_20,
  SCENARIO_F_ALL_MINUS_50,
  SCENARIO_F_DAILY_WEIGHTED,
  SCENARIO_F_MONTHLY_WEIGHTED,
  SCENARIO_G_PRECLAIM,
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
  preClaimDiscount: DEFAULT_PRE_CLAIM_DISCOUNT,
  preClaimAdoption: DEFAULT_PRE_CLAIM_ADOPTION,
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
// MULTI-CADENCE SCENARIOS (change daily + weekly + monthly together)
// ════════════════════════════════════════════════════════════════════════════

// ─── (M1) multiCadenceHeadlineRate == Σ of the three per-cadence rates ───────
console.log("[rakeback forecast checks] (M1) multi-cadence headline = Σ per-cadence rates");
{
  const headline = multiCadenceHeadlineRate({
    perCadenceRate: { daily: 0.02, weekly: 0.012, monthly: 0.008 },
  });
  check(
    `(M1) headline == 0.04 (0.02 + 0.012 + 0.008) (${headline.toFixed(4)})`,
    Math.abs(headline - 0.04) < 1e-12,
  );
  check(
    "(M1) a zero cadence contributes nothing",
    Math.abs(
      multiCadenceHeadlineRate({ perCadenceRate: { daily: 0.03, weekly: 0, monthly: 0 } }) - 0.03,
    ) < 1e-12,
  );
  // The static F-* policies expose their effective rate as the headline sum.
  const f20Rate = effectiveRateForSegment(SCENARIO_F_ALL_MINUS_20.policy, "whales");
  // F-all-minus-20 = MC_BASELINE × 0.8 = (0.025+0.015+0.01)×0.8 = 0.04.
  check(
    `(M1) F-all-minus-20 effective rate == 0.04 (5% headline × 0.8) (${f20Rate.toFixed(4)})`,
    Math.abs(f20Rate - 0.04) < 1e-9,
  );
  // The effective rate is FLAT across segments for a multi_cadence policy.
  check(
    "(M1) multi-cadence rate is flat across all segments",
    SEGMENT_IDS.every(
      (id) => Math.abs(effectiveRateForSegment(SCENARIO_F_ALL_MINUS_20.policy, id) - f20Rate) < 1e-12,
    ),
  );
}

// ─── (M2) the combined-cadence trims cost ≤ baseline & monotone in depth ─────
console.log("[rakeback forecast checks] (M2) combined-cadence trims: cost ≤ baseline, deeper = cheaper");
{
  const set = simulateSet(SCENARIO_LIBRARY, A, WINDOW, BASELINE_SCENARIO_ID, REAL_TOTAL);
  const byId = new Map(set.map((r) => [r.scenarioId, r]));
  const baseline = byId.get(BASELINE_SCENARIO_ID)!;
  const f20 = byId.get(SCENARIO_F_ALL_MINUS_20.id)!;
  const f50 = byId.get(SCENARIO_F_ALL_MINUS_50.id)!;
  check(
    `(M2) all −20% costs ≤ baseline ($${f20.bonusCost.toFixed(0)} ≤ $${baseline.bonusCost.toFixed(0)})`,
    f20.bonusCost <= baseline.bonusCost + 1e-3,
  );
  check(
    `(M2) all −50% costs < all −20% (deeper cut is cheaper: $${f50.bonusCost.toFixed(0)} < $${f20.bonusCost.toFixed(0)})`,
    f50.bonusCost < f20.bonusCost,
  );
  check(
    `(M2) all −20% gross savings ≥ 0 ($${f20.savingsVsBaseline.toFixed(0)})`,
    f20.savingsVsBaseline >= -1e-3,
  );
  // Every F-* scenario is finite + segment-summed.
  const fAll = set.filter((r) => /^F-/.test(r.scenarioId));
  check("(M2) there ARE ≥5 multi-cadence scenarios", fAll.length >= 5);
  check("(M2) every multi-cadence result is finite", fAll.every(allFinite));
  for (const r of fAll) {
    const segSum = r.perSegment.reduce((a, s) => a + s.bonusCost, 0);
    check(
      `(M2) "${r.scenarioId}" segment costs sum to total`,
      Math.abs(segSum - r.bonusCost) < 1e-2,
    );
    check(`(M2) "${r.scenarioId}" cost ≥ 0`, r.bonusCost >= 0);
  }
  // Daily-weighted (raise daily, cut weekly+monthly) vs monthly-weighted (cut
  // daily, raise monthly): with daily breakage LOWER than monthly, a daily-
  // weighted mix at a similar headline realizes a HIGHER cost than monthly-
  // weighted (monthly forfeits more to breakage). Both must be finite + sane.
  const dw = byId.get(SCENARIO_F_DAILY_WEIGHTED.id)!;
  const mw = byId.get(SCENARIO_F_MONTHLY_WEIGHTED.id)!;
  check("(M2) daily-weighted result finite", allFinite(dw));
  check("(M2) monthly-weighted result finite", allFinite(mw));
}

// ════════════════════════════════════════════════════════════════════════════
// PRE-CLAIM @ 65% (instant cash-out lever)
// ════════════════════════════════════════════════════════════════════════════

// ─── (P1) preClaimCostFactor + savings math (the wired formula) ──────────────
console.log("[rakeback forecast checks] (P1) pre-claim cost factor & savings formula");
{
  const breakage = 0.1;
  const discount = 0.65;
  const alpha = 0.4;
  // factor = α·discount + (1−α)·(1−breakage) = 0.4·0.65 + 0.6·0.9 = 0.26 + 0.54 = 0.80.
  const factor = preClaimCostFactor(breakage, discount, alpha);
  check(`(P1) factor == 0.80 (0.4·0.65 + 0.6·0.9) (${factor.toFixed(4)})`, Math.abs(factor - 0.8) < 1e-9);
  // saving = α·[(1−breakage) − discount] = 0.4·(0.9 − 0.65) = 0.4·0.25 = 0.10.
  const saving = preClaimSavingPerAccrual(breakage, discount, alpha);
  check(`(P1) saving == 0.10 (0.4·(0.9−0.65)) (${saving.toFixed(4)})`, Math.abs(saving - 0.1) < 1e-9);
  // Identity: factor == (1−breakage) − saving (cost is reduced by the saving).
  check(
    "(P1) factor == (1 − breakage) − saving (cost reduced by the saving)",
    Math.abs(factor - ((1 - breakage) - saving)) < 1e-9,
  );
  // adoption 0 ⇒ lever inert ⇒ factor == (1 − breakage), saving == 0.
  check(
    "(P1) adoption 0 ⇒ factor == (1 − breakage) (lever inert)",
    Math.abs(preClaimCostFactor(breakage, discount, 0) - (1 - breakage)) < 1e-9,
  );
  check("(P1) adoption 0 ⇒ saving == 0", Math.abs(preClaimSavingPerAccrual(breakage, discount, 0)) < 1e-12);
  // A GENEROUS discount above the normal payout ⇒ a COST (negative saving).
  check(
    "(P1) discount 0.95 > (1−breakage)=0.9 ⇒ negative saving (a cost, not a saving)",
    preClaimSavingPerAccrual(breakage, 0.95, alpha) < 0,
  );
  // Factor stays in [0,1] for degenerate inputs.
  check("(P1) factor finite & in [0,1] for degenerate inputs", (() => {
    const f = preClaimCostFactor(NaN, NaN, NaN);
    return Number.isFinite(f) && f >= 0 && f <= 1;
  })());
}

// ─── (P2) the pre-claim SCENARIO saves vs baseline (default discount) ────────
console.log("[rakeback forecast checks] (P2) Pre-claim @ 65% scenario nets savings vs baseline");
{
  const set = simulateSet(SCENARIO_LIBRARY, A, WINDOW, BASELINE_SCENARIO_ID, REAL_TOTAL);
  const byId = new Map(set.map((r) => [r.scenarioId, r]));
  const baseline = byId.get(BASELINE_SCENARIO_ID)!;
  const preClaim = byId.get(SCENARIO_G_PRECLAIM.id)!;
  check("(P2) pre-claim scenario present", !!preClaim);
  // Same policy as baseline, pre-claim ON. Default discount 0.65 < (1−breakage)
  // (breakage = 0.12 × 0.8 daily = 0.096 ⇒ 1−breakage ≈ 0.904), so the adopting
  // 40% cost LESS than a normal claim ⇒ the scenario is CHEAPER than baseline.
  check(
    `(P2) pre-claim costs < baseline ($${preClaim.bonusCost.toFixed(0)} < $${baseline.bonusCost.toFixed(0)})`,
    preClaim.bonusCost < baseline.bonusCost,
  );
  // Same policy ⇒ same retained revenue ⇒ net savings == gross savings ≥ 0.
  check(`(P2) pre-claim gross savings > 0 ($${preClaim.savingsVsBaseline.toFixed(0)})`, preClaim.savingsVsBaseline > 0);
  // The discounted payout retains slightly LESS downstream than a full claim
  // (retention is modeled proportional to the rakeback paid to genuine players),
  // so net savings is ≤ gross — the honest "we save on cost but the smaller
  // payout retains a touch less downstream" effect. Net must still be positive.
  check(
    `(P2) pre-claim net savings ≤ gross savings (smaller payout retains less downstream: net $${preClaim.netSavingsVsBaseline.toFixed(0)} ≤ gross $${preClaim.savingsVsBaseline.toFixed(0)})`,
    preClaim.netSavingsVsBaseline <= preClaim.savingsVsBaseline + 1e-6,
  );
  check(
    `(P2) pre-claim net savings > 0 ($${preClaim.netSavingsVsBaseline.toFixed(0)})`,
    preClaim.netSavingsVsBaseline > 0,
  );
  // Same policy ⇒ same friction as the baseline (pre-claim doesn't add friction).
  check(
    "(P2) pre-claim friction == baseline friction (same headline policy)",
    Math.abs(preClaim.frictionScore - baseline.frictionScore) < 1e-9,
  );
  check("(P2) pre-claim result finite + segment-summed", allFinite(preClaim) &&
    Math.abs(preClaim.perSegment.reduce((a, s) => a + s.bonusCost, 0) - preClaim.bonusCost) < 1e-2);

  // The GROSS savings must equal the task's exact formula: at the anchored scale,
  // savings = baselineCost × α × [(1−breakage) − discount] / (1−breakage). The
  // baseline pays `accrued × (1−breakage)`; pre-claim pays `accrued × factor`; so
  // gross savings = accrued × [(1−breakage) − factor] = accrued × α·[(1−breakage)
  // − discount]. Re-expressed against the anchored baseline cost (= accrued ×
  // (1−breakage) after scaling), the ratio savings/baselineCost == α·[(1−breakage)
  // − discount] / (1−breakage).
  {
    const brk = effectiveBreakage(SCENARIO_G_PRECLAIM.policy, A.breakageRate); // 0.12 × 0.8 = 0.096
    const normal = 1 - brk;
    const expectedRatio =
      (DEFAULT_PRE_CLAIM_ADOPTION * (normal - DEFAULT_PRE_CLAIM_DISCOUNT)) / normal;
    const actualRatio = preClaim.savingsVsBaseline / baseline.bonusCost;
    check(
      `(P2) gross savings ratio matches the task formula (α·[(1−brk)−disc]/(1−brk)) (${actualRatio.toFixed(5)} ≈ ${expectedRatio.toFixed(5)})`,
      Math.abs(actualRatio - expectedRatio) < 1e-6,
    );
  }
}

// ─── (P3) a NON-pre-claim scenario ignores the pre-claim levers ──────────────
console.log("[rakeback forecast checks] (P3) pre-claim levers only bite on opt-in scenarios");
{
  // Baseline (no preClaim flag) must be IDENTICAL whether the pre-claim sliders
  // are at their defaults or cranked — the levers must not leak into it.
  const baseSet = simulateSet([SCENARIO_A_BASELINE], A, WINDOW, BASELINE_SCENARIO_ID);
  const crankedAssumptions: Assumptions = { ...A, preClaimDiscount: 0.1, preClaimAdoption: 1 };
  const crankedSet = simulateSet([SCENARIO_A_BASELINE], crankedAssumptions, WINDOW, BASELINE_SCENARIO_ID);
  check(
    "(P3) baseline cost is invariant to the pre-claim sliders (flag off)",
    Math.abs(baseSet[0].bonusCost - crankedSet[0].bonusCost) < 1e-9,
  );
  // The pre-claim SCENARIO, by contrast, MUST respond: a deeper discount (0.1)
  // at full adoption (1) is far cheaper than the default.
  const gDefault = simulateSet([SCENARIO_G_PRECLAIM], A, WINDOW, SCENARIO_G_PRECLAIM.id)[0];
  const gCranked = simulateSet([SCENARIO_G_PRECLAIM], crankedAssumptions, WINDOW, SCENARIO_G_PRECLAIM.id)[0];
  check(
    `(P3) pre-claim scenario responds to the discount slider (cranked ${gCranked.bonusCost.toFixed(0)} < default ${gDefault.bonusCost.toFixed(0)})`,
    gCranked.bonusCost < gDefault.bonusCost,
  );
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

    // ── Live multi-cadence (F) scenarios exist + anchor-faithfully cost ≤ baseline.
    const liveF = set.filter((r) => /^F-/.test(r.scenarioId));
    check("(L) live builder emits multi-cadence (F) scenarios (multi-cadence policy)", liveF.length >= 4);
    const fAll20 = set.find((r) => r.scenarioId === "F-all-minus-20");
    const fAll50 = set.find((r) => r.scenarioId === "F-all-minus-50");
    check("(L) live F-all-minus-20 present", !!fAll20);
    if (fAll20 && fAll50) {
      check(
        `(L) live all −20% costs ≤ baseline ($${fAll20.bonusCost.toFixed(0)} ≤ $${baseRes.bonusCost.toFixed(0)})`,
        fAll20.bonusCost <= baseRes.bonusCost + 1e-3,
      );
      check(
        `(L) live all −50% costs < all −20% ($${fAll50.bonusCost.toFixed(0)} < $${fAll20.bonusCost.toFixed(0)})`,
        fAll50.bonusCost < fAll20.bonusCost,
      );
    }
    // The live multi-cadence policies must be the `multi_cadence` kind AND their
    // per-cadence rates must SUM to the modeled blended rate (anchor-faithful),
    // so the cadence breakdown renders in the policy column without breaking the
    // anchor. Spot-check the −20% variant against its modeled headline.
    const f20Scenario = scenarios.find((s) => s.id === "F-all-minus-20");
    check("(L) F-all-minus-20 is a multi_cadence policy", f20Scenario?.policy.kind === "multi_cadence");
    if (f20Scenario && f20Scenario.policy.kind === "multi_cadence") {
      const sum = multiCadenceHeadlineRate(f20Scenario.policy);
      // Real headline after ×0.8 = 0.40% × 0.8 = 0.32%; modeled = blended × (0.32/0.40).
      const modeledExpected = MEASURED_BLENDED * ((REAL_HEADLINE * 0.8) / REAL_HEADLINE);
      check(
        `(L) F-all-minus-20 per-cadence rates sum to the modeled blended (${(sum * 100).toFixed(4)}% ≈ ${(modeledExpected * 100).toFixed(4)}%)`,
        Math.abs(sum - modeledExpected) < 1e-9,
      );
      // The policy label surfaces the per-cadence breakdown (D / W / M).
      const label = f20Scenario.description;
      check(
        "(L) F-all-minus-20 description shows the per-cadence breakdown (Daily/Weekly/Monthly)",
        /Daily/.test(label) && /Weekly/.test(label) && /Monthly/.test(label),
      );
    }

    // ── Live pre-claim (G) scenario exists + saves vs baseline at the defaults.
    const livePreClaim = set.find((r) => r.scenarioId === "G-preclaim-65");
    check("(L) live builder emits the pre-claim (G) scenario", !!livePreClaim);
    if (livePreClaim) {
      check(
        `(L) live pre-claim costs < baseline ($${livePreClaim.bonusCost.toFixed(0)} < $${baseRes.bonusCost.toFixed(0)})`,
        livePreClaim.bonusCost < baseRes.bonusCost,
      );
      check(`(L) live pre-claim gross savings > 0`, livePreClaim.savingsVsBaseline > 0);
    }
    const gScenario = scenarios.find((s) => s.id === "G-preclaim-65");
    check("(L) live pre-claim scenario carries the preClaim flag", gScenario?.preClaim === true);

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
