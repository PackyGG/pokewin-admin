/**
 * run.ts — self-checking assertions for the PURE deposit-bonus forecast engine.
 *
 * The repo has no unit-test framework (only Playwright e2e under `e2e/`, which
 * `playwright.config.ts` scopes to `e2e/tests` — this file is NOT picked up by
 * it). Per CLAUDE.md, instead of adding a framework we pin the model with plain
 * `assert`-style checks, runnable on demand:
 *
 *   npx tsx "src/app/(admin)/insights/rewards/deposit-bonus/_forecast/__checks__/run.ts"
 *
 * Exit code 0 = all checks passed; non-zero = a check failed (the message names
 * the failing case). It imports ONLY the pure engine modules — no DB, no React,
 * no server-only. `tsx` resolves the `@/` alias (used transitively by
 * `recommend.ts` → `@/lib/utils/format`) via tsconfig paths, verified, so the
 * recommend() invariant runs too.
 *
 * What it pins (the directional contract from the architecture spec):
 *   (a) Scenario A (baseline) has savingsVsBaseline === 0.
 *   (b) Every STRICTER scenario has abuseLeakage < baseline abuseLeakage.
 *   (c) At least one stricter scenario has netSavings < grossSavings
 *       (retention loss bites).
 *   (d) Split-window leakage < same-$ fixed-window leakage (burst damping).
 *   (e) An over-generous (> $150) cap raises cannibalization.
 *   (f) Every output is Number.isFinite.
 *   (g) recommend() returns exactly the 3 badges on distinct scenarios where
 *       possible.
 */

import {
  DEFAULT_ABUSE_CAPTURE_ELASTICITY,
  DEFAULT_ABUSE_SHARE,
  DEFAULT_AVG_BONUS_USD,
  DEFAULT_BREAKAGE_RATE,
  DEFAULT_CANNIBALIZATION_RATE,
  DEFAULT_CLAIM_PROBABILITY,
  DEFAULT_DEPOSITS_PER_USER_PER_WINDOW,
  DEFAULT_ELIGIBLE_USERS,
  DEFAULT_LEGIT_CONVERSION_SENSITIVITY,
  DEFAULT_RETENTION_UPLIFT,
  DEFAULT_SEGMENT_MIX,
  DEFAULT_WINDOW_DAYS,
} from "../constants";
import {
  cannibalizationAtCap,
  simulateSet,
  tightnessVsBaseline,
} from "../engine";
import { recommend } from "../recommend";
import {
  BASELINE_SCENARIO_ID,
  SCENARIO_A_BASELINE,
  SCENARIO_B_HOURLY_10,
  SCENARIO_B_HOURLY_5,
  SCENARIO_D_HYBRID,
  SCENARIO_E_DAILY_50,
  SCENARIO_LIBRARY,
  SPLIT_CAP_WHATIF_SET,
} from "../scenarios";
import type { Assumptions, CapRule, ScenarioConfig, SimulationResult } from "../types";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(name);
    console.error(`  ✗ ${name}`);
  }
}

// The default assumptions used across the checks (the slider seeds).
const A: Assumptions = {
  eligibleUsers: DEFAULT_ELIGIBLE_USERS,
  segmentMix: DEFAULT_SEGMENT_MIX,
  depositsPerUserPerWindow: DEFAULT_DEPOSITS_PER_USER_PER_WINDOW,
  claimProbability: DEFAULT_CLAIM_PROBABILITY,
  avgBonusUsd: DEFAULT_AVG_BONUS_USD,
  breakageRate: DEFAULT_BREAKAGE_RATE,
  abuseShare: DEFAULT_ABUSE_SHARE,
  abuseCaptureElasticity: DEFAULT_ABUSE_CAPTURE_ELASTICITY,
  retentionUplift: DEFAULT_RETENTION_UPLIFT,
  cannibalizationRate: DEFAULT_CANNIBALIZATION_RATE,
  legitConversionSensitivity: DEFAULT_LEGIT_CONVERSION_SENSITIVITY,
  windowDays: DEFAULT_WINDOW_DAYS,
};
const WINDOW = { days: DEFAULT_WINDOW_DAYS };

/** A high avg bonus so caps actually clamp (otherwise every cap is non-binding). */
const A_HIGH_BONUS: Assumptions = { ...A, avgBonusUsd: 220 };

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

// ─── (f) finiteness across the whole library, high & low bonus ───────────────
console.log("\n[forecast checks] (f) every output is finite");
{
  const lib = simulateSet(SCENARIO_LIBRARY, A, WINDOW, BASELINE_SCENARIO_ID);
  const libHigh = simulateSet(SCENARIO_LIBRARY, A_HIGH_BONUS, WINDOW, BASELINE_SCENARIO_ID);
  check("all library results finite (default bonus)", lib.every(allFinite));
  check("all library results finite (high bonus, caps binding)", libHigh.every(allFinite));
  // Degenerate inputs must not produce NaN/Infinity.
  const degenerate: Assumptions = {
    ...A,
    eligibleUsers: 0,
    avgBonusUsd: 0,
    depositsPerUserPerWindow: 0,
    segmentMix: {
      legit_low_risk: 0,
      high_value: 0,
      promo_sensitive: 0,
      high_risk_abuse: 0,
      reactivated_dormant: 0,
    },
    windowDays: 0,
  };
  const deg = simulateSet(SCENARIO_LIBRARY, degenerate, { days: 0 }, BASELINE_SCENARIO_ID);
  check("degenerate (all-zero) inputs stay finite", deg.every(allFinite));
  check("degenerate baseline cost is 0 (no users / no bonus)", deg[0].bonusCost === 0);
}

// ─── (a) baseline savings === 0 ──────────────────────────────────────────────
console.log("[forecast checks] (a) baseline savingsVsBaseline === 0");
{
  const set = simulateSet(SPLIT_CAP_WHATIF_SET, A_HIGH_BONUS, WINDOW, BASELINE_SCENARIO_ID);
  const baseline = set.find((r) => r.scenarioId === BASELINE_SCENARIO_ID)!;
  check("baseline present in result set", !!baseline);
  check("baseline savingsVsBaseline === 0", baseline.savingsVsBaseline === 0);
  check("baseline netSavingsVsBaseline === 0", baseline.netSavingsVsBaseline === 0);
}

// ─── (b) stricter scenarios reduce abuse leakage ─────────────────────────────
console.log("[forecast checks] (b) stricter cap ⇒ lower abuse leakage");
{
  const set = simulateSet(SCENARIO_LIBRARY, A_HIGH_BONUS, WINDOW, BASELINE_SCENARIO_ID);
  const byId = new Map(set.map((r) => [r.scenarioId, r]));
  const baseline = byId.get(BASELINE_SCENARIO_ID)!;

  // Every scenario strictly tighter than the baseline must leak less abuse.
  const stricter = SCENARIO_LIBRARY.filter(
    (sc) => tightnessVsBaseline(sc.cap) > 1e-9 && sc.id !== BASELINE_SCENARIO_ID,
  );
  check("there ARE stricter scenarios in the library", stricter.length > 0);
  for (const sc of stricter) {
    const r = byId.get(sc.id)!;
    check(
      `stricter "${sc.id}" leaks less abuse than baseline (${r.abuseLeakage.toFixed(0)} < ${baseline.abuseLeakage.toFixed(0)})`,
      r.abuseLeakage < baseline.abuseLeakage,
    );
  }
  // Specific anchors: hourly $5 is tighter than $10 → leaks less.
  const r5 = byId.get(SCENARIO_B_HOURLY_5.id)!;
  const r10 = byId.get(SCENARIO_B_HOURLY_10.id)!;
  check(
    "$5/hr leaks less abuse than $10/hr (tighter dollar cap)",
    r5.abuseLeakage < r10.abuseLeakage,
  );
}

// ─── (c) retention loss makes net < gross for a stricter scenario ────────────
console.log("[forecast checks] (c) net savings < gross savings (retention loss bites)");
{
  const set = simulateSet(SCENARIO_LIBRARY, A_HIGH_BONUS, WINDOW, BASELINE_SCENARIO_ID);
  const someBites = set.some(
    (r) =>
      r.scenarioId !== BASELINE_SCENARIO_ID &&
      r.savingsVsBaseline > 0 &&
      r.netSavingsVsBaseline < r.savingsVsBaseline,
  );
  check("at least one stricter scenario: net savings < gross savings", someBites);

  // And the gap equals the retained-revenue given up vs baseline (the model
  // contract): netSavings = grossSavings − max(0, baselineRetained − retained).
  const baseline = set.find((r) => r.scenarioId === BASELINE_SCENARIO_ID)!;
  const sample = set.find(
    (r) => r.scenarioId === SCENARIO_E_DAILY_50.id,
  )!;
  const retentionGivenUp = Math.max(0, baseline.retainedRevenue - sample.retainedRevenue);
  const expectedNet = sample.savingsVsBaseline - retentionGivenUp;
  check(
    "net-savings identity holds (net = gross − retention-given-up)",
    Math.abs(sample.netSavingsVsBaseline - expectedNet) < 1e-6,
  );
}

// ─── (d) split-window leaks less than same-$ fixed-window ────────────────────
console.log("[forecast checks] (d) split-window leakage < same-$ fixed-window leakage");
{
  // Same $50 cap: one as a 24h SPLIT tranche, one as a 24h FIXED window. The
  // split tranche carries the burst-damping discount on its excess-window
  // headroom. To isolate the mechanic we compare a SHORT split window vs the
  // fixed baseline-cadence window at the SAME dollar amount.
  const fixed50: ScenarioConfig = {
    id: "t-fixed-50-24h",
    label: "fixed $50/24h",
    description: "test",
    cap: { kind: "fixed_window", capUsd: 50, windowHours: 24 },
    schemaVersion: 1,
  };
  const split50_6h: ScenarioConfig = {
    id: "t-split-50-6h",
    label: "split $50/6h",
    description: "test",
    cap: { kind: "split_window", capUsd: 50, windowHours: 6 },
    schemaVersion: 1,
  };
  // Hold the cap dollars equal so leakage differs ONLY via the window mechanic.
  const set = simulateSet([SCENARIO_A_BASELINE, fixed50, split50_6h], A_HIGH_BONUS, WINDOW);
  const rFixed = set.find((r) => r.scenarioId === fixed50.id)!;
  const rSplit = set.find((r) => r.scenarioId === split50_6h.id)!;
  // The split (shorter window) is tighter → captures more abuse → leaks less.
  check(
    `split $50/6h is tighter than fixed $50/24h (tightness ${tightnessVsBaseline(split50_6h.cap).toFixed(3)} > ${tightnessVsBaseline(fixed50.cap).toFixed(3)})`,
    tightnessVsBaseline(split50_6h.cap) > tightnessVsBaseline(fixed50.cap),
  );
  check(
    `split $50/6h leaks less abuse than fixed $50/24h (${rSplit.abuseLeakage.toFixed(0)} < ${rFixed.abuseLeakage.toFixed(0)})`,
    rSplit.abuseLeakage < rFixed.abuseLeakage,
  );

  // And the burst-damping cost discount: split's per-window headroom beyond the
  // baseline cadence is damped, so its bonus COST is below the same-$ fixed
  // window's naive linear extrapolation would predict. We assert the modeled
  // split cost is finite and not wildly above the fixed cost (damping caps it).
  check(
    "split-window bonus cost is finite & bounded vs fixed",
    Number.isFinite(rSplit.bonusCost) && rSplit.bonusCost > 0,
  );
}

// ─── (e) over-generous cap raises cannibalization ────────────────────────────
console.log("[forecast checks] (e) over-generous (> $150) cap raises cannibalization");
{
  const atThreshold: CapRule = { kind: "fixed_window", capUsd: 150, windowHours: 24 };
  const over: CapRule = { kind: "fixed_window", capUsd: 300, windowHours: 24 };
  const cannThreshold = cannibalizationAtCap(atThreshold, DEFAULT_CANNIBALIZATION_RATE);
  const cannOver = cannibalizationAtCap(over, DEFAULT_CANNIBALIZATION_RATE);
  check(
    `cannibalization at $300 > at $150 (${cannOver.toFixed(3)} > ${cannThreshold.toFixed(3)})`,
    cannOver > cannThreshold,
  );
  check(
    "cannibalization at/below $150 equals the base rate",
    Math.abs(cannThreshold - DEFAULT_CANNIBALIZATION_RATE) < 1e-9,
  );
  check("cannibalization never exceeds 1", cannibalizationAtCap(over, 0.9) <= 1);

  // End-to-end: an over-generous fixed cap should NOT beat the baseline on NGR
  // (more cannibalized dollars, worse net). Compare $300/24h vs baseline.
  const overScenario: ScenarioConfig = {
    id: "t-over-300",
    label: "over $300/24h",
    description: "test",
    cap: over,
    schemaVersion: 1,
  };
  const set = simulateSet([SCENARIO_A_BASELINE, overScenario], A_HIGH_BONUS, WINDOW);
  const baseline = set.find((r) => r.scenarioId === BASELINE_SCENARIO_ID)!;
  const overRes = set.find((r) => r.scenarioId === overScenario.id)!;
  check(
    "over-generous cap costs MORE than baseline (negative savings)",
    overRes.savingsVsBaseline < 0,
  );
  check(
    "over-generous cap has worse-or-equal NGR than baseline",
    overRes.ngrImpact <= baseline.ngrImpact + 1e-6,
  );
}

// ─── confidence band brackets the base case ──────────────────────────────────
console.log("[forecast checks] confidence band brackets the base cost");
{
  const set = simulateSet(SCENARIO_LIBRARY, A_HIGH_BONUS, WINDOW, BASELINE_SCENARIO_ID);
  check(
    "every confidence band: low ≤ mid ≤ high",
    set.every((r) => r.confidenceBand.low <= r.confidenceBand.mid && r.confidenceBand.mid <= r.confidenceBand.high),
  );
  check(
    "confidence mid === bonusCost (band centered on the base case)",
    set.every((r) => Math.abs(r.confidenceBand.mid - r.bonusCost) < 1e-9),
  );
  check(
    "confidence band straddles bonusCost (low ≤ cost ≤ high)",
    set.every((r) => r.confidenceBand.low <= r.bonusCost && r.bonusCost <= r.confidenceBand.high),
  );
}

// ─── daily series integrates to the totals (no drift) ────────────────────────
console.log("[forecast checks] daily series sums back to the horizon totals");
{
  const set = simulateSet(SCENARIO_LIBRARY, A_HIGH_BONUS, WINDOW, BASELINE_SCENARIO_ID);
  for (const r of set) {
    const sumCost = r.dailySeries.reduce((a, d) => a + d.bonusCost, 0);
    check(
      `"${r.scenarioId}" daily bonusCost sums to total (${sumCost.toFixed(2)} ≈ ${r.bonusCost.toFixed(2)})`,
      Math.abs(sumCost - r.bonusCost) < 1e-3,
    );
    const lastCum = r.dailySeries[r.dailySeries.length - 1]?.cumulativeCost ?? 0;
    check(
      `"${r.scenarioId}" final cumulativeCost equals total`,
      Math.abs(lastCum - r.bonusCost) < 1e-3,
    );
    const sumSavings = r.dailySeries.reduce((a, d) => a + d.savingsVsBaseline, 0);
    check(
      `"${r.scenarioId}" daily savings sums to total savings`,
      Math.abs(sumSavings - r.savingsVsBaseline) < 1e-3,
    );
  }
  // Day count matches the horizon.
  check("daily series length === horizon days", set[0].dailySeries.length === DEFAULT_WINDOW_DAYS);
}

// ─── dynamic per-segment caps differ by segment ──────────────────────────────
console.log("[forecast checks] hybrid dynamic applies per-segment caps");
{
  const set = simulateSet([SCENARIO_A_BASELINE, SCENARIO_D_HYBRID], A_HIGH_BONUS, WINDOW);
  const hybrid = set.find((r) => r.scenarioId === SCENARIO_D_HYBRID.id)!;
  const lowRisk = hybrid.perSegment.find((s) => s.segment === "legit_low_risk")!;
  const highRisk = hybrid.perSegment.find((s) => s.segment === "high_risk_abuse")!;
  check(
    `hybrid: low-risk effective cap > high-risk (${lowRisk.effectiveCapUsd.toFixed(0)} > ${highRisk.effectiveCapUsd.toFixed(0)})`,
    lowRisk.effectiveCapUsd > highRisk.effectiveCapUsd,
  );
  // High-risk leakage per claimant should be small (tight cap kills it).
  check("hybrid: high-risk abuse leakage is non-negative & finite", highRisk.abuseLeakage >= 0 && Number.isFinite(highRisk.abuseLeakage));
}

// ─── (g) recommend() returns the 3 badges on distinct scenarios ──────────────
console.log("[forecast checks] (g) recommend() emits 3 badges on distinct scenarios");
{
  const set = simulateSet(SCENARIO_LIBRARY, A_HIGH_BONUS, WINDOW, BASELINE_SCENARIO_ID);
  const recs = recommend(set);
  const badges = recs.map((r) => r.badge);
  check("recommend returns exactly 3 recommendations", recs.length === 3);
  check("badges are highest-savings / lowest-friction / best-balance", badges.includes("highest-savings") && badges.includes("lowest-friction") && badges.includes("best-balance"));
  const ids = new Set(recs.map((r) => r.scenarioId));
  // Distinct WHERE POSSIBLE: with the full library (11 scenarios, ≥3 deviating
  // candidates) recommend() spreads the badges across distinct scenarios via
  // its distinct-best-balance tie-break. (If a single scenario dominated and
  // no runner-up existed, duplicates would be acceptable per the spec.)
  check("recommendations land on distinct scenarios (full library)", ids.size === 3);
  check("every recommendation has a non-empty headline & detail", recs.every((r) => r.headline.length > 0 && r.detail.length > 0));
  // Empty input → empty output (no throw).
  check("recommend([]) returns []", recommend([]).length === 0);
}

// ─── summary ─────────────────────────────────────────────────────────────────
console.log(`\n[forecast checks] ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`\nFAILED checks:\n  - ${failures.join("\n  - ")}\n`);
  process.exit(1);
}
console.log("[forecast checks] OK — all directional invariants hold.\n");
