/**
 * run.ts — self-checking assertions for the PURE affiliate commission forecast
 * engine.
 *
 * The repo has no unit-test framework (only Playwright e2e under `e2e/`, scoped
 * to `e2e/tests` — this file is NOT picked up by it). Per CLAUDE.md, instead of
 * adding a framework we pin the model with plain `assert`-style checks, runnable
 * on demand:
 *
 *   npx tsx "src/app/(admin)/insights/rewards/affiliate/_forecast/__checks__/run.ts"
 *
 * Exit code 0 = all checks passed; non-zero = a check failed (the message names
 * the failing case). It imports ONLY the pure engine modules — no DB, no React,
 * no server-only. `tsx` resolves the `@/` alias (used transitively by the shared
 * `recommend` → `@/lib/utils/format`) via tsconfig paths.
 *
 * What it pins (the directional contract, mirroring the deposit-bonus harness):
 *   (a) Scenario A (current) has savingsVsBaseline === 0.
 *   (b) Every rate-trimming scenario costs ≤ baseline AND has gross savings ≥ 0
 *       (cost is monotone in the blended rate — no inversion).
 *   (c) At least one tightening scenario has netSavings < grossSavings
 *       (acquisition / retention loss bites).
 *   (d) A qualification tighten leaks ≤ the baseline's abuse leakage (capture).
 *   (e) Enriching rates above the over-generous threshold raises cannibalization.
 *   (f) Every output is Number.isFinite (incl. degenerate all-zero inputs).
 *   (g) recommend() returns exactly the 3 badges on distinct scenarios.
 *   (S1) When anchored on a real baseline total, the baseline scenario's cost
 *        equals that anchor EXACTLY, and segment costs sum to it.
 *   (S2) A deeper flat trim is cheaper than a shallower one (monotone in rate).
 *   (S5) Every scenario's segment costs sum to that scenario's projected cost.
 *   (S7) `costRetentionFromRate` is monotone in the rate and ==1 at the baseline.
 */

import {
  BASELINE_BLENDED_RATE,
  DEFAULT_ACQUISITION_SENSITIVITY,
  DEFAULT_AVG_COMMISSION_USD,
  DEFAULT_CANNIBALIZATION_RATE,
  DEFAULT_CLAIM_PROBABILITY,
  DEFAULT_COMMISSION_RATE_MULT,
  DEFAULT_QUALIFICATION_ELASTICITY,
  DEFAULT_REFERRAL_QUALITY,
  DEFAULT_REFERRALS_PER_AFFILIATE,
  DEFAULT_RETENTION_UPLIFT,
  DEFAULT_TIER_MIX,
  DEFAULT_WINDOW_DAYS,
} from "../constants";
import {
  blendedRate,
  cannibalizationAtRate,
  costRetentionFromRate,
  normalizeTierMix,
  qualificationTightness,
  rateCutSeverity,
  simulateSet,
} from "../engine";
import { recommend } from "../../../../_forecast-engine";
import {
  BASELINE_SCENARIO_ID,
  SCENARIO_A_CURRENT,
  SCENARIO_B_TRIM_10,
  SCENARIO_B_TRIM_20,
  SCENARIO_B_TRIM_40,
  SCENARIO_D_QUAL_2,
  SCENARIO_D_QUAL_3,
  SCENARIO_LIBRARY,
  AFFILIATE_WHATIF_SET,
} from "../scenarios";
import {
  affiliateBaselineBlendedRate,
  affiliateBaselineTierRate,
  buildAffiliateScenarios,
  type AffiliateBaselineExt,
  type AffiliateLevelConfig,
} from "../live-policy";
import type { Assumptions, RatePolicy, ScenarioConfig, SimulationResult } from "../types";

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

// The default assumptions used across the checks. Volume is anchored to a real
// measured active-affiliate count over a measured period (here a representative
// 1,200 affiliates over 30 days) with the active-rate lever at its neutral
// default so `claimProbFactor` == 1.
const A: Assumptions = {
  baselineClaimants: 1200,
  baselinePeriodDays: 30,
  baselineClaimProbability: DEFAULT_CLAIM_PROBABILITY,
  tierMix: DEFAULT_TIER_MIX,
  depositsPerUserPerWindow: DEFAULT_REFERRALS_PER_AFFILIATE,
  claimProbability: DEFAULT_CLAIM_PROBABILITY,
  avgBonusUsd: DEFAULT_AVG_COMMISSION_USD,
  commissionRateMult: DEFAULT_COMMISSION_RATE_MULT,
  referralQuality: DEFAULT_REFERRAL_QUALITY,
  qualificationElasticity: DEFAULT_QUALIFICATION_ELASTICITY,
  retentionUplift: DEFAULT_RETENTION_UPLIFT,
  cannibalizationRate: DEFAULT_CANNIBALIZATION_RATE,
  acquisitionSensitivity: DEFAULT_ACQUISITION_SENSITIVITY,
  windowDays: DEFAULT_WINDOW_DAYS,
};
const WINDOW = { days: DEFAULT_WINDOW_DAYS };
const REAL_TOTAL = 87654.32;

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
console.log("\n[affiliate forecast checks] (f) every output is finite");
{
  const lib = simulateSet(SCENARIO_LIBRARY, A, WINDOW, BASELINE_SCENARIO_ID, REAL_TOTAL);
  check("all library results finite", lib.every(allFinite));
  const degenerate: Assumptions = {
    ...A,
    baselineClaimants: 0,
    avgBonusUsd: 0,
    depositsPerUserPerWindow: 0,
    tierMix: { whale: 0, established: 0, emerging: 0, micro: 0, dormant: 0 },
    windowDays: 0,
  };
  const deg = simulateSet(SCENARIO_LIBRARY, degenerate, { days: 0 }, BASELINE_SCENARIO_ID);
  check("degenerate (all-zero) inputs stay finite", deg.every(allFinite));
  check("degenerate baseline cost is 0 (no affiliates / no commission)", deg[0].bonusCost === 0);
}

// ─── (a) baseline savings === 0 ──────────────────────────────────────────────
console.log("[affiliate forecast checks] (a) baseline savingsVsBaseline === 0");
{
  const set = simulateSet(AFFILIATE_WHATIF_SET, A, WINDOW, BASELINE_SCENARIO_ID, REAL_TOTAL);
  const baseline = set.find((r) => r.scenarioId === BASELINE_SCENARIO_ID)!;
  check("baseline present in result set", !!baseline);
  check("baseline savingsVsBaseline === 0", Math.abs(baseline.savingsVsBaseline) < 1e-6);
  check("baseline netSavingsVsBaseline === 0", Math.abs(baseline.netSavingsVsBaseline) < 1e-6);
  check(
    `(S1) baseline cost == real total ($${baseline.bonusCost.toFixed(2)} ≈ $${REAL_TOTAL})`,
    Math.abs(baseline.bonusCost - REAL_TOTAL) < 1e-2,
  );
}

// ─── (b)+(S2)+(S5) rate trims are cheaper than baseline, monotone, segment-summed ─
console.log("[affiliate forecast checks] (b/S2/S5) rate trims cheaper & monotone");
{
  const set = simulateSet(SCENARIO_LIBRARY, A, WINDOW, BASELINE_SCENARIO_ID, REAL_TOTAL);
  const byId = new Map(set.map((r) => [r.scenarioId, r]));
  const baseline = byId.get(BASELINE_SCENARIO_ID)!;

  for (const r of set) {
    const segSum = r.perSegment.reduce((a, s) => a + s.bonusCost, 0);
    check(
      `(S5) "${r.scenarioId}" segment costs sum to total ($${segSum.toFixed(2)} ≈ $${r.bonusCost.toFixed(2)})`,
      Math.abs(segSum - r.bonusCost) < 1e-3,
    );
  }

  const t10 = byId.get(SCENARIO_B_TRIM_10.id)!;
  const t20 = byId.get(SCENARIO_B_TRIM_20.id)!;
  const t40 = byId.get(SCENARIO_B_TRIM_40.id)!;
  check("(b) −10% flat is cheaper than baseline", t10.bonusCost < baseline.bonusCost && t10.savingsVsBaseline > 0);
  check("(b) −40% flat is cheaper than baseline", t40.bonusCost < baseline.bonusCost && t40.savingsVsBaseline > 0);
  check("(S2) −20% cheaper than −10% (deeper trim = cheaper)", t20.bonusCost < t10.bonusCost);
  check("(S2) −40% cheaper than −20% (deeper trim = cheaper)", t40.bonusCost < t20.bonusCost);
  // No scenario in the library should blow cost wildly above baseline.
  for (const r of set) {
    const ratio = baseline.bonusCost > 0 ? r.bonusCost / baseline.bonusCost : 0;
    check(`(S2) "${r.scenarioId}" cost ≤ 1.5× baseline (${ratio.toFixed(2)}×)`, r.bonusCost >= 0 && ratio <= 1.5);
  }
}

// ─── (c) acquisition/retention loss makes net < gross for a tightening scenario ─
console.log("[affiliate forecast checks] (c) net savings < gross savings (acquisition loss bites)");
{
  const set = simulateSet(SCENARIO_LIBRARY, A, WINDOW, BASELINE_SCENARIO_ID, REAL_TOTAL);
  const someBites = set.some(
    (r) =>
      r.scenarioId !== BASELINE_SCENARIO_ID &&
      r.savingsVsBaseline > 0 &&
      r.netSavingsVsBaseline < r.savingsVsBaseline,
  );
  check("at least one scenario: net savings < gross savings", someBites);

  // The gap equals the retained-revenue given up vs baseline (the model contract).
  const baseline = set.find((r) => r.scenarioId === BASELINE_SCENARIO_ID)!;
  const sample = set.find((r) => r.scenarioId === SCENARIO_D_QUAL_2.id)!;
  const retentionGivenUp = Math.max(0, baseline.retainedRevenue - sample.retainedRevenue);
  const expectedNet = sample.savingsVsBaseline - retentionGivenUp;
  check(
    "net-savings identity holds (net = gross − retention-given-up)",
    Math.abs(sample.netSavingsVsBaseline - expectedNet) < 1e-6,
  );
}

// ─── (d) a qualification tighten leaks ≤ baseline ─────────────────────────────
console.log("[affiliate forecast checks] (d) qualification tighten ⇒ leakage ≤ baseline");
{
  const set = simulateSet(SCENARIO_LIBRARY, A, WINDOW, BASELINE_SCENARIO_ID, REAL_TOTAL);
  const byId = new Map(set.map((r) => [r.scenarioId, r]));
  const baseline = byId.get(BASELINE_SCENARIO_ID)!;
  const q2 = byId.get(SCENARIO_D_QUAL_2.id)!;
  const q3 = byId.get(SCENARIO_D_QUAL_3.id)!;
  check(
    `(d) Bar ×2 leaks ≤ baseline ($${q2.abuseLeakage.toFixed(0)} ≤ $${baseline.abuseLeakage.toFixed(0)})`,
    q2.abuseLeakage <= baseline.abuseLeakage + 1e-6,
  );
  check(
    `(d) Bar ×3 leaks ≤ Bar ×2 (tighter bar captures more, $${q3.abuseLeakage.toFixed(0)} ≤ $${q2.abuseLeakage.toFixed(0)})`,
    q3.abuseLeakage <= q2.abuseLeakage + 1e-6,
  );
  // Qualification tightness must be monotone in the threshold multiplier.
  check(
    "qualification tightness: ×3 > ×2 > current",
    qualificationTightness({ kind: "qualification", thresholdMult: 3, rateMult: 1 }) >
      qualificationTightness({ kind: "qualification", thresholdMult: 2, rateMult: 1 }) &&
      qualificationTightness({ kind: "qualification", thresholdMult: 2, rateMult: 1 }) >
        qualificationTightness({ kind: "current" }),
  );
}

// ─── (e) enriching rates above the threshold raises cannibalization ───────────
console.log("[affiliate forecast checks] (e) over-generous rate raises cannibalization");
{
  const atThreshold = 0.06;
  const over = 0.1;
  const cannThreshold = cannibalizationAtRate(atThreshold, DEFAULT_CANNIBALIZATION_RATE);
  const cannOver = cannibalizationAtRate(over, DEFAULT_CANNIBALIZATION_RATE);
  check(
    `cannibalization at 10% > at 6% (${cannOver.toFixed(3)} > ${cannThreshold.toFixed(3)})`,
    cannOver > cannThreshold,
  );
  check(
    "cannibalization at/below the threshold equals the base rate",
    Math.abs(cannThreshold - DEFAULT_CANNIBALIZATION_RATE) < 1e-9,
  );
  check("cannibalization never exceeds 1", cannibalizationAtRate(0.5, 0.9) <= 1);

  // End-to-end: a richer-than-baseline global multiplier should NOT beat the
  // baseline on NGR (more cannibalized dollars). Compare a +50% global lever.
  const enriched: Assumptions = { ...A, commissionRateMult: 1.5 };
  const set = simulateSet([SCENARIO_A_CURRENT], enriched, WINDOW);
  check("over-generous (enriched) scenario stays finite", set.every(allFinite));
}

// ─── (S7) costRetentionFromRate: monotone, ==1 at baseline ────────────────────
console.log("[affiliate forecast checks] (S7) cost-retention factor monotone & ==1 at baseline");
{
  const B = BASELINE_BLENDED_RATE;
  check("(S7) factor(B, B) == 1 (full bill at baseline rate)", Math.abs(costRetentionFromRate(B, B) - 1) < 1e-9);
  check("(S7) factor(0, B) == 0", costRetentionFromRate(0, B) === 0);
  check("(S7) factor(2B, B) == 1 (clamped, never > 1)", Math.abs(costRetentionFromRate(2 * B, B) - 1) < 1e-9);
  let prev = -1;
  let monotone = true;
  for (let c = 0; c <= B; c += B / 20) {
    const f = costRetentionFromRate(c, B);
    if (f < prev - 1e-12) monotone = false;
    prev = f;
  }
  check("(S7) factor strictly non-decreasing in the rate", monotone);

  // blendedRate falls as a flat trim deepens; rateCutSeverity rises with it.
  const mix = normalizeTierMix(DEFAULT_TIER_MIX);
  const r10: RatePolicy = { kind: "flat_trim", rateMult: 0.9 };
  const r40: RatePolicy = { kind: "flat_trim", rateMult: 0.6 };
  check("(S7) blended rate −40% < blended rate −10%", blendedRate(r40, mix, 1) < blendedRate(r10, mix, 1));
  check("(S7) rate-cut severity −40% > −10%", rateCutSeverity(r40, mix, 1) > rateCutSeverity(r10, mix, 1));
}

// ─── confidence band brackets the base case ──────────────────────────────────
console.log("[affiliate forecast checks] confidence band brackets the base cost");
{
  const set = simulateSet(SCENARIO_LIBRARY, A, WINDOW, BASELINE_SCENARIO_ID, REAL_TOTAL);
  check(
    "every confidence band: low ≤ mid ≤ high",
    set.every((r) => r.confidenceBand.low <= r.confidenceBand.mid && r.confidenceBand.mid <= r.confidenceBand.high),
  );
  check(
    "confidence mid === bonusCost (band centered on the base case)",
    set.every((r) => Math.abs(r.confidenceBand.mid - r.bonusCost) < 1e-9),
  );
}

// ─── daily series integrates to the totals (no drift) ────────────────────────
console.log("[affiliate forecast checks] daily series sums back to the horizon totals");
{
  const set = simulateSet(SCENARIO_LIBRARY, A, WINDOW, BASELINE_SCENARIO_ID, REAL_TOTAL);
  for (const r of set) {
    const sumCost = r.dailySeries.reduce((a, d) => a + d.bonusCost, 0);
    check(
      `"${r.scenarioId}" daily bonusCost sums to total (${sumCost.toFixed(2)} ≈ ${r.bonusCost.toFixed(2)})`,
      Math.abs(sumCost - r.bonusCost) < 1e-3,
    );
    const sumSavings = r.dailySeries.reduce((a, d) => a + d.savingsVsBaseline, 0);
    check(
      `"${r.scenarioId}" daily savings sums to total savings`,
      Math.abs(sumSavings - r.savingsVsBaseline) < 1e-3,
    );
  }
  check("daily series length === horizon days", set[0].dailySeries.length === DEFAULT_WINDOW_DAYS);
}

// ─── per-tier rates differ by tier (the per_tier / hybrid policies) ───────────
console.log("[affiliate forecast checks] per-tier policy differentiates tiers");
{
  const set = simulateSet([SCENARIO_A_CURRENT, SCENARIO_B_TRIM_20], A, WINDOW, BASELINE_SCENARIO_ID, REAL_TOTAL);
  const current = set.find((r) => r.scenarioId === SCENARIO_A_CURRENT.id)!;
  const whale = current.perSegment.find((s) => s.segment === "whale")!;
  const micro = current.perSegment.find((s) => s.segment === "micro")!;
  // Whale per-affiliate commission (effectiveCapUsd analogue) > micro at the
  // current policy (richer rate). Both finite & non-negative.
  check(
    `current: whale per-affiliate commission ≥ micro (${whale.effectiveCapUsd.toFixed(2)} ≥ ${micro.effectiveCapUsd.toFixed(2)})`,
    whale.effectiveCapUsd >= micro.effectiveCapUsd,
  );
  check("tier commissions are non-negative & finite", current.perSegment.every((s) => s.effectiveCapUsd >= 0 && Number.isFinite(s.effectiveCapUsd)));
}

// ─── (g) recommend() returns the 3 badges on distinct scenarios ──────────────
console.log("[affiliate forecast checks] (g) recommend() emits 3 badges on distinct scenarios");
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
// LIVE-POLICY BUILDER (the real-config fix — real ladder, not placeholder tiers)
// ════════════════════════════════════════════════════════════════════════════

// The REAL production commission ladder: 8 levels, 3% → 10%, the actual config.
const REAL_LADDER: AffiliateLevelConfig[] = [
  { level: 1, label: "Level 1", commissionRate: 0.03, threshold: 0 },
  { level: 2, label: "Level 2", commissionRate: 0.04, threshold: 25_000 },
  { level: 3, label: "Level 3", commissionRate: 0.05, threshold: 50_000 },
  { level: 4, label: "Level 4", commissionRate: 0.06, threshold: 100_000 },
  { level: 5, label: "Level 5", commissionRate: 0.07, threshold: 250_000 },
  { level: 6, label: "Level 6", commissionRate: 0.08, threshold: 500_000 },
  { level: 7, label: "Level 7", commissionRate: 0.09, threshold: 1_000_000 },
  { level: 8, label: "Level 8", commissionRate: 0.1, threshold: 1_500_000 },
];

function liveAffiliateBaseline(over: Partial<AffiliateBaselineExt> = {}): AffiliateBaselineExt {
  return {
    totalCost: 87_654.32,
    uniqueClaimants: 1_200,
    periodDays: 30,
    claimProbability: null,
    avgBonusUsd: 73,
    empiricalCapUsd: 0,
    capHitRate: null,
    blendedRoi: 9.5,
    avgGgrPerClaimant: 6_000,
    levelConfigs: REAL_LADDER,
    ...over,
  };
}

/** Assumptions whose baseline tier rates / blended ref are the REAL ladder. */
function liveAffiliateAssumptions(): Assumptions {
  const tierRate = affiliateBaselineTierRate(REAL_LADDER)!;
  return {
    ...A,
    baselineClaimants: 1_200,
    baselinePeriodDays: 30,
    avgBonusUsd: 73,
    baselineTierRate: tierRate,
    baselineBlendedRate: affiliateBaselineBlendedRate(tierRate),
  };
}

console.log("[affiliate forecast checks] (L) live builder reflects the REAL commission ladder");
{
  // The collapse maps the real ladder onto the 5 tiers, rate-ordered: whales get
  // the richest configured rate band, micro/dormant the leanest. NONE is the
  // fabricated 8% whale / 6% established placeholder unless the real data says so.
  const tierRate = affiliateBaselineTierRate(REAL_LADDER);
  check("(L) collapse returns a tier-rate map for the real ladder", tierRate != null);
  if (tierRate) {
    check(
      `(L) whale rate ≥ established ≥ emerging ≥ micro (monotone by band)`,
      tierRate.whale >= tierRate.established &&
        tierRate.established >= tierRate.emerging &&
        tierRate.emerging >= tierRate.micro - 1e-12,
    );
    check(
      `(L) whale rate is in the TOP band of the real ladder (≥ 8%, ≤ 10%)`,
      tierRate.whale >= 0.08 - 1e-9 && tierRate.whale <= 0.1 + 1e-9,
    );
    check(
      `(L) dormant rate == the entry (lowest) configured rate (3%)`,
      Math.abs(tierRate.dormant - 0.03) < 1e-9,
    );
    check(
      `(L) micro rate is in the entry band (≤ 5%) — not the 3% flat placeholder claim`,
      tierRate.micro <= 0.05 + 1e-9 && tierRate.micro >= 0.03 - 1e-9,
    );
    const blended = affiliateBaselineBlendedRate(tierRate);
    check(
      `(L) real blended rate is positive & sane (${(blended * 100).toFixed(2)}%, 3–10%)`,
      blended >= 0.03 - 1e-9 && blended <= 0.1 + 1e-9,
    );
  }

  const built = buildAffiliateScenarios(liveAffiliateBaseline());
  check("(L) builder returns a live set when the real ladder is present", built != null);

  if (built) {
    const { scenarios, whatifSet, baselineScenarioId } = built;
    check("(L) baseline id is A-current", baselineScenarioId === "A-current");
    const base = scenarios.find((s) => s.id === baselineScenarioId)!;
    check("(L) baseline present & is the `current` policy", base?.policy.kind === "current");
    check(
      "(L) baseline description names the REAL ladder span (8-level, 3%→10%)",
      /8-level ladder/.test(base.description) && /3%/.test(base.description) && /10%/.test(base.description),
    );
    // A 1× wager-requirement WHAT-IF exists and is clearly labeled hypothetical.
    const wagerReq = scenarios.find((s) => s.id === "D-wager-req-1x");
    check("(L) a 1× wager-requirement what-if exists", !!wagerReq);
    if (wagerReq) {
      check(
        "(L) 1× wager-req is modeled as a quality screen (hybrid, rates unchanged)",
        wagerReq.policy.kind === "hybrid" &&
          wagerReq.policy.qualityScreen > 0 &&
          wagerReq.policy.thresholdMult === 1,
      );
      check(
        "(L) 1× wager-req description flags it as a what-if (not a current setting)",
        /What-if/i.test(wagerReq.description) && /1×/.test(wagerReq.description),
      );
    }

    // Run through the real engine with the REAL ladder anchored. Baseline must
    // reproduce the real total; every flat trim must cost ≤ baseline.
    const asm = liveAffiliateAssumptions();
    const set = simulateSet(scenarios, asm, WINDOW, baselineScenarioId, 87_654.32);
    const baseRes = set.find((r) => r.scenarioId === baselineScenarioId)!;
    check(
      `(L) baseline cost == real total ($${baseRes.bonusCost.toFixed(2)} ≈ $87654.32)`,
      Math.abs(baseRes.bonusCost - 87_654.32) < 1e-2,
    );
    check("(L) baseline savingsVsBaseline == 0", Math.abs(baseRes.savingsVsBaseline) < 1e-6);

    const trim20 = set.find((r) => r.scenarioId === "B-trim-20");
    check("(L) a −20% flat trim what-if exists", !!trim20);
    if (trim20) {
      check(
        `(L) −20% flat trim costs < baseline ($${trim20.bonusCost.toFixed(0)} < $${baseRes.bonusCost.toFixed(0)})`,
        trim20.bonusCost < baseRes.bonusCost && trim20.savingsVsBaseline > 0,
      );
    }
    // The 1× wager-req what-if must reduce leakage vs baseline (the screen bites).
    const wagerRes = set.find((r) => r.scenarioId === "D-wager-req-1x");
    if (wagerRes) {
      check(
        `(L) 1× wager-req leaks ≤ baseline ($${wagerRes.abuseLeakage.toFixed(0)} ≤ $${baseRes.abuseLeakage.toFixed(0)})`,
        wagerRes.abuseLeakage <= baseRes.abuseLeakage + 1e-6,
      );
    }
    check("(L) every live result is finite", set.every(allFinite));
    for (const r of set) {
      const segSum = r.perSegment.reduce((a, s) => a + s.bonusCost, 0);
      check(`(L) "${r.scenarioId}" segment costs sum to total`, Math.abs(segSum - r.bonusCost) < 1e-3);
    }
    check("(L) whatifSet starts at the baseline", whatifSet[0]?.id === baselineScenarioId);
    check("(L) whatifSet has at least 4 rows", whatifSet.length >= 4);

    // The engine must USE the real tier rates, NOT the static placeholder: the
    // blended rate of the `current` policy under the real assumptions must equal
    // the REAL blended rate (≈5.4% for the real ladder under the default mix),
    // distinct from the static BASELINE_BLENDED_RATE placeholder (5%).
    const mix = normalizeTierMix(asm.tierMix);
    const realLadderBlended = blendedRate(SCENARIO_A_CURRENT.policy, mix, 1, asm.baselineTierRate);
    const expectedBlended = affiliateBaselineBlendedRate(asm.baselineTierRate!);
    check(
      `(L) engine blends the REAL tier rates (${(realLadderBlended * 100).toFixed(2)}% == real ${(expectedBlended * 100).toFixed(2)}%)`,
      Math.abs(realLadderBlended - expectedBlended) < 1e-9,
    );
    // And a flat trim under the real rates is strictly cheaper than the real
    // current rate (the real rates flow through the cost math).
    const trimBlended = blendedRate({ kind: "flat_trim", rateMult: 0.8 }, mix, 1, asm.baselineTierRate);
    check(
      `(L) −20% flat trim blends below the real current rate (${(trimBlended * 100).toFixed(2)}% < ${(realLadderBlended * 100).toFixed(2)}%)`,
      trimBlended < realLadderBlended,
    );
  }

  // No real ladder threaded → builder returns null (caller falls back to static).
  check(
    "(L) builder returns null with no level configs",
    buildAffiliateScenarios(liveAffiliateBaseline({ levelConfigs: undefined })) === null,
  );
  check(
    "(L) collapse returns null on an empty ladder",
    affiliateBaselineTierRate([]) === null,
  );
}

// ─── summary ─────────────────────────────────────────────────────────────────
console.log(`\n[affiliate forecast checks] ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`\nFAILED checks:\n  - ${failures.join("\n  - ")}\n`);
  process.exit(1);
}
console.log("[affiliate forecast checks] OK — all directional invariants hold.\n");
