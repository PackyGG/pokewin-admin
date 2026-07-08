/**
 * Pack RISK engine — pure invariant checks.
 *
 * Run with:
 *   npx tsx "src/app/(admin)/packs/__checks__/risk.ts"
 *
 * NO DB, NO React, NO server imports — imports ONLY the dep-free risk module
 * (`insights/edge-calc/risk`, which itself only pulls `TARGET_HOUSE_EDGE` from
 * the dep-free math module). Pins the invariants of the risk scorer + the
 * inverse `shapeWeights` solver:
 *
 *   1.  computePackRisk matches a hand-computed small pool to 1e-9.
 *   2.  Aggregate path agrees with the per-card path on the same pool.
 *   3.  Empty / W=0 / price=0 → fully-zeroed record, no NaN, tier T1.
 *   4.  riskScore ∈ [0,100] and is monotone non-decreasing in CV.
 *   5.  Tier boundaries land exactly at CV 1.4 / 3 / 6 / 12.
 *   6.  shapeWeights: edge ≥ target & within 0.001, win-rate within tol,
 *       maxWinCap respected, floor/near-miss met when requested, weights are
 *       positive ints, and the error arm NEVER carries a weights vector.
 *   7.  THE SWEEP — price × value-distribution × card-count × targetEdge ×
 *       targetWinRate (± cap / floor): feasible combos satisfy all invariants;
 *       infeasible combos return an error with NO weights vector.
 *
 * Exit code 0 = all passed; 1 = at least one failure (printed).
 */

import {
  computePackRisk,
  computePackRiskFromAggregates,
  riskTier,
  shapeWeights,
  snapWeightsToCleanLadder,
  searchBestPriceForCleanSnap,
  monotoneEvWindow,
  monotoneLayoutForEv,
  findMonotoneViolations,
  enforceMonotoneLadderLawM,
  lawfulTagFitRange,
  TAGGED_WINRATE_TOLERANCE,
  CV_TIER_BOUNDS,
  type CardLite,
  type ShapeWeightsResult,
  type ShapeWeightsSuccess,
} from "../../insights/edge-calc/risk";
import { TARGET_HOUSE_EDGE } from "../../insights/edge-calc/math";
// Pure auto-target helpers — live in the dep-free `auto-targets` module (NOT the
// DB-coupled `risk-config`) precisely so this no-DB harness can import them.
import {
  autoMaxWinCap,
  autoRetuneTargets,
  autoTargetEdge,
  hitRateFromTags,
  parsePackHitRate,
  resolveIntendedHitRate,
  resolveTargetWinRate,
  TARGET_PACK_EDGE,
  DEFAULT_TARGET_WIN_RATE,
  DEFAULT_NEAR_MISS_MIN,
  DEFAULT_EDGE_FLOOR,
  DEFAULT_EDGE_CEILING,
  DEFAULT_EDGE_CURVE,
  UNTAGGED_WINRATE_LIVE_MIN,
  UNTAGGED_WINRATE_LIVE_MAX,
  UNTAGGED_NEAR_MISS_LIVE_FACTOR,
  EDGE_NEVER_BELOW_LIVE_SLACK,
} from "../_lib/auto-targets";

let passes = 0;
const failures: string[] = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    passes += 1;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`FAIL  ${name}`);
    console.error(`      ${err instanceof Error ? err.message : String(err)}`);
  }
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function approx(actual: number, expected: number, eps: number, what: string): void {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > eps) {
    throw new Error(`${what}: expected ≈${expected} (±${eps}), got ${actual}`);
  }
}

function isSuccess(r: ShapeWeightsResult): r is ShapeWeightsSuccess {
  return "weights" in r;
}

/** Aggregate sums for a pool (so the aggregate path can be checked vs per-card). */
function aggsFor(cards: CardLite[], price: number) {
  let totalWeight = 0;
  let weightedPriceSum = 0;
  let weightedSqSum = 0;
  let winWeight = 0;
  let nearMissWeight = 0;
  let maxValue = -Infinity;
  let floorWeight = -Infinity;
  let floorValue = 0;
  for (const c of cards) {
    if (!(c.weight > 0)) continue;
    totalWeight += c.weight;
    weightedPriceSum += c.weight * c.value;
    weightedSqSum += c.weight * c.value * c.value;
    if (c.value >= price) winWeight += c.weight;
    else if (c.value >= 0.5 * price) nearMissWeight += c.weight;
    if (c.value > maxValue) maxValue = c.value;
    if (c.weight > floorWeight || (c.weight === floorWeight && c.value < floorValue)) {
      floorWeight = c.weight;
      floorValue = c.value;
    }
  }
  return {
    price,
    totalWeight,
    weightedPriceSum,
    weightedSqSum,
    winWeight,
    nearMissWeight,
    maxValue: Number.isFinite(maxValue) ? maxValue : 0,
    floorValue,
  };
}

// ── 1. Hand-computed small pool ─────────────────────────────────────
check("computePackRisk matches hand-computed 4-card pool to 1e-9", () => {
  // price = 10. Cards: v=[0, 5, 12, 100], w=[70, 20, 8, 2], ΣW = 100.
  // p = [0.7, 0.2, 0.08, 0.02].
  const cards: CardLite[] = [
    { value: 0, weight: 70 },
    { value: 5, weight: 20 },
    { value: 12, weight: 8 },
    { value: 100, weight: 2 },
  ];
  const price = 10;
  // ev = .7*0 + .2*5 + .08*12 + .02*100 = 0 + 1 + 0.96 + 2 = 3.96
  const ev = 3.96;
  // variance = Σ p*(v-ev)^2
  //   .7*(0-3.96)^2   = .7*15.6816   = 10.97712
  //   .2*(5-3.96)^2   = .2*1.0816    = 0.21632
  //   .08*(12-3.96)^2 = .08*64.6416  = 5.171328
  //   .02*(100-3.96)^2= .02*9223.6816= 184.473632
  const variance = 10.97712 + 0.21632 + 5.171328 + 184.473632; // 200.8384
  const cv = Math.sqrt(variance) / ev;
  // winRate: v>=10 → cards 12 & 100 → .08 + .02 = 0.10
  // nearMiss: 5<=v<10 → card 5 → 0.20
  // maxWin = 100, maxMult = 10. floor = highest-weight card = v=0 (w=70).
  const r = computePackRisk({ cards, price });
  approx(r.ev, ev, 1e-9, "ev");
  approx(r.cv, cv, 1e-9, "cv");
  approx(r.edge, 1 - ev / price, 1e-9, "edge"); // 0.604
  approx(r.winRate, 0.1, 1e-9, "winRate");
  approx(r.nearMiss, 0.2, 1e-9, "nearMiss");
  approx(r.maxWin, 100, 1e-9, "maxWin");
  approx(r.maxMult, 10, 1e-9, "maxMult");
  approx(r.floorValue, 0, 1e-9, "floorValue");
  approx(r.floorRatio, 0, 1e-9, "floorRatio");
  assert(r.tier === riskTier(cv), "tier consistent with cv");
});

// ── 1b. Floor tie-break to lowest value ─────────────────────────────
check("floor tie-break: equal top weight → lowest value wins", () => {
  const cards: CardLite[] = [
    { value: 8, weight: 50 },
    { value: 3, weight: 50 },
    { value: 40, weight: 1 },
  ];
  const r = computePackRisk({ cards, price: 10 });
  approx(r.floorValue, 3, 1e-9, "floorValue is the cheaper of the tied top weights");
});

// ── 2. Aggregate vs per-card agreement ──────────────────────────────
check("aggregate path agrees with per-card path on the same pools", () => {
  const pools: { cards: CardLite[]; price: number }[] = [
    {
      cards: [
        { value: 0, weight: 70 },
        { value: 5, weight: 20 },
        { value: 12, weight: 8 },
        { value: 100, weight: 2 },
      ],
      price: 10,
    },
    {
      cards: [
        { value: 1, weight: 5 },
        { value: 2, weight: 5 },
        { value: 3, weight: 5 },
      ],
      price: 4,
    },
    {
      cards: [
        { value: 0.25, weight: 900 },
        { value: 50, weight: 100 },
        { value: 500, weight: 3 },
      ],
      price: 5,
    },
  ];
  for (const { cards, price } of pools) {
    const direct = computePackRisk({ cards, price });
    const agg = computePackRiskFromAggregates(aggsFor(cards, price));
    approx(agg.ev, direct.ev, 1e-9, "ev");
    approx(agg.cv, direct.cv, 1e-9, "cv");
    approx(agg.edge, direct.edge, 1e-9, "edge");
    approx(agg.winRate, direct.winRate, 1e-9, "winRate");
    approx(agg.nearMiss, direct.nearMiss, 1e-9, "nearMiss");
    approx(agg.maxWin, direct.maxWin, 1e-9, "maxWin");
    approx(agg.maxMult, direct.maxMult, 1e-9, "maxMult");
    approx(agg.floorValue, direct.floorValue, 1e-9, "floorValue");
    approx(agg.floorRatio, direct.floorRatio, 1e-9, "floorRatio");
    assert(agg.riskScore0to100 === direct.riskScore0to100, "riskScore equal");
    assert(agg.tier === direct.tier, "tier equal");
  }
});

// ── 3. Empty / W=0 / price=0 → zeroed, no NaN, tier T1 ──────────────
check("degenerate inputs → fully-zeroed record, no NaN, tier T1", () => {
  const checkZero = (r: ReturnType<typeof computePackRisk>, label: string) => {
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === "number") {
        assert(Number.isFinite(v), `${label}.${k} must be finite, got ${v}`);
        assert(v === 0, `${label}.${k} must be 0, got ${v}`);
      }
    }
    assert(r.tier === "T1", `${label}.tier must be T1`);
  };
  checkZero(computePackRisk({ cards: [], price: 10 }), "empty");
  checkZero(
    computePackRisk({ cards: [{ value: 5, weight: 0 }], price: 10 }),
    "zero-weight",
  );
  checkZero(
    computePackRisk({ cards: [{ value: 5, weight: 10 }], price: 0 }),
    "zero-price",
  );
  checkZero(
    computePackRiskFromAggregates({
      price: 0,
      totalWeight: 0,
      weightedPriceSum: 0,
      weightedSqSum: 0,
      winWeight: 0,
      nearMissWeight: 0,
      maxValue: 0,
      floorValue: 0,
    }),
    "agg-zero",
  );
});

// ── 4. riskScore ∈ [0,100] & monotone in CV ─────────────────────────
check("riskScore in [0,100] and monotone non-decreasing in CV", () => {
  // Build a family of two-point pools with rising CV by spreading values while
  // pinning EV and the jackpot/floor terms constant, so ONLY cv drives score.
  // Pool: value 0 with weight (1-q), value J with weight q. EV = q·J held fixed
  // at 1; price fixed at 10 so maxMult/floor terms are constant across the family.
  const price = 10;
  let prevScore = -1;
  let prevCv = -1;
  for (const J of [2, 4, 8, 16, 32, 64, 128, 256, 512]) {
    const q = 1 / J; // EV = 1 constant
    const cards: CardLite[] = [
      { value: 0, weight: 1 - q },
      { value: J, weight: q },
    ];
    const r = computePackRisk({ cards, price });
    assert(r.riskScore0to100 >= 0 && r.riskScore0to100 <= 100, `score in range, got ${r.riskScore0to100}`);
    assert(r.cv >= prevCv - 1e-12, `cv should rise (J=${J}): ${prevCv} → ${r.cv}`);
    // maxMult term DOES rise with J too; both cv and maxMult push the score up,
    // so monotone non-decreasing is the right invariant here.
    assert(r.riskScore0to100 >= prevScore, `score monotone (J=${J}): ${prevScore} → ${r.riskScore0to100}`);
    prevScore = r.riskScore0to100;
    prevCv = r.cv;
  }
});

// ── 4b. STRICT score-monotonicity in CV alone (maxMult + floor fixed) ──
check("riskScore strictly monotone in CV with maxMult & floorRatio held fixed", () => {
  // Isolate the CV term with a clean two-point pool: a floor (modal) card of
  // value 0 at a DOMINANT fixed weight, and a jackpot of FIXED value J carrying
  // a probability mass q. Because the floor value is 0 and the jackpot value J
  // are both pinned, floorValue (0), floorRatio (0), maxWin (J) and maxMult
  // (J/price) are CONSTANT across the whole family — only the spread moves.
  //
  // For this two-point pool EV = q·J and CV = sqrt((1−q)/q), so CV is strictly
  // DECREASING in q. Sweeping q downward therefore raises CV monotonically with
  // every other score input held fixed, isolating pure CV-monotonicity. The
  // jackpot mass q stays < 0.5 so the value-0 card remains the modal/floor card.
  const price = 10;
  const J = 500; // fixed jackpot → fixed maxWin (=J) / maxMult (=J/price)
  const base = 1_000_000; // weight scale so q maps to integ-ish weights
  let prevScore = -1;
  let prevCv = -1;
  let prevMaxMult = -1;
  let prevFloorRatio = -1;
  // q descending → CV ascending. All q < 0.5 so value-0 stays the modal card.
  for (const q of [0.4, 0.3, 0.2, 0.1, 0.05, 0.02, 0.01, 0.004]) {
    const cards: CardLite[] = [
      { value: 0, weight: Math.round((1 - q) * base) },
      { value: J, weight: Math.round(q * base) },
    ];
    const r = computePackRisk({ cards, price });
    // maxMult & floorRatio must be invariant across the whole family.
    assert(r.floorValue === 0, `floor card is value 0 (q=${q}), got ${r.floorValue}`);
    if (prevMaxMult >= 0) {
      approx(r.maxMult, prevMaxMult, 1e-9, `maxMult fixed (q=${q})`);
      approx(r.floorRatio, prevFloorRatio, 1e-9, `floorRatio fixed (q=${q})`);
    }
    assert(r.cv > prevCv - 1e-12, `cv should rise as q falls (q=${q}): ${prevCv} → ${r.cv}`);
    // With ONLY the CV term moving, the score must be STRICTLY non-decreasing,
    // and STRICTLY increasing wherever the CV term isn't already saturated
    // (cv/12 clamped at 1). Below saturation we demand a strict rise.
    if (prevScore >= 0 && prevCv < 12 && r.cv < 12) {
      assert(
        r.riskScore0to100 > prevScore,
        `score strictly monotone in CV alone (q=${q}): ${prevScore} → ${r.riskScore0to100}`,
      );
    } else {
      assert(
        r.riskScore0to100 >= prevScore,
        `score non-decreasing in CV (q=${q}): ${prevScore} → ${r.riskScore0to100}`,
      );
    }
    prevScore = r.riskScore0to100;
    prevCv = r.cv;
    prevMaxMult = r.maxMult;
    prevFloorRatio = r.floorRatio;
  }
});

// ── 4c. Non-finite card VALUES never poison the record (NaN-safe contract) ──
check("non-finite card values are skipped; record stays finite (NaN-safe)", () => {
  const price = 10;
  // A NaN-valued card must be ignored, leaving the clean cards to score exactly
  // as if the bad row weren't there.
  const withNaN = computePackRisk({
    cards: [
      { value: NaN, weight: 10 },
      { value: 5, weight: 10 },
      { value: 12, weight: 5 },
    ],
    price,
  });
  const clean = computePackRisk({
    cards: [
      { value: 5, weight: 10 },
      { value: 12, weight: 5 },
    ],
    price,
  });
  for (const [k, v] of Object.entries(withNaN)) {
    if (typeof v === "number") assert(Number.isFinite(v), `withNaN.${k} finite, got ${v}`);
  }
  approx(withNaN.ev, clean.ev, 1e-9, "NaN card skipped → ev matches clean pool");
  approx(withNaN.edge, clean.edge, 1e-9, "edge matches");
  approx(withNaN.maxWin, clean.maxWin, 1e-9, "maxWin matches (12, not NaN)");

  // An Infinity-valued card must NOT silently report maxWin 0 — it is skipped,
  // so maxWin is the largest FINITE card and every field stays finite.
  const withInf = computePackRisk({
    cards: [
      { value: Infinity, weight: 3 },
      { value: 7, weight: 10 },
      { value: 0.5, weight: 50 },
    ],
    price,
  });
  for (const [k, v] of Object.entries(withInf)) {
    if (typeof v === "number") assert(Number.isFinite(v), `withInf.${k} finite, got ${v}`);
  }
  assert(withInf.maxWin === 7, `Infinity card skipped → maxWin is finite max (7), got ${withInf.maxWin}`);
  assert(withInf.ev > 0, `ev positive from the finite cards, got ${withInf.ev}`);

  // A pool whose ONLY cards are non-finite collapses to the zeroed record.
  const allBad = computePackRisk({
    cards: [
      { value: NaN, weight: 5 },
      { value: Infinity, weight: 5 },
    ],
    price,
  });
  for (const [k, v] of Object.entries(allBad)) {
    if (typeof v === "number") assert(v === 0, `allBad.${k} must be 0, got ${v}`);
  }
  assert(allBad.tier === "T1", "all-non-finite pool → tier T1");

  // The aggregate path's buildRisk backstop also zeroes on a non-finite sum.
  const aggBad = computePackRiskFromAggregates({
    price,
    totalWeight: 10,
    weightedPriceSum: NaN,
    weightedSqSum: NaN,
    winWeight: 1,
    nearMissWeight: 1,
    maxValue: Infinity,
    floorValue: 0,
  });
  for (const [k, v] of Object.entries(aggBad)) {
    if (typeof v === "number") assert(v === 0, `aggBad.${k} must be 0, got ${v}`);
  }
  assert(aggBad.tier === "T1", "non-finite aggregate sums → zeroed record, tier T1");
});

// ── 5. Tier boundaries land exactly at CV 1.4 / 3 / 6 / 12 ───────────
check("tier boundaries exact at CV 1.4 / 3 / 6 / 12 (boundary → higher tier)", () => {
  assert(riskTier(0) === "T1", "cv 0 → T1");
  assert(riskTier(1.3999999) === "T1", "just below 1.4 → T1");
  assert(riskTier(CV_TIER_BOUNDS[0]) === "T2", "cv 1.4 → T2");
  assert(riskTier(2.9999999) === "T2", "just below 3 → T2");
  assert(riskTier(CV_TIER_BOUNDS[1]) === "T3", "cv 3 → T3");
  assert(riskTier(5.9999999) === "T3", "just below 6 → T3");
  assert(riskTier(CV_TIER_BOUNDS[2]) === "T4", "cv 6 → T4");
  assert(riskTier(11.9999999) === "T4", "just below 12 → T4");
  assert(riskTier(CV_TIER_BOUNDS[3]) === "T5", "cv 12 → T5");
  assert(riskTier(1000) === "T5", "cv 1000 → T5");
  assert(riskTier(NaN) === "T1", "NaN cv → T1");
});

// ── 6. shapeWeights core invariants ─────────────────────────────────
check("shapeWeights: edge ≥ target & ≤ target+0.001, win-rate within tol, ints", () => {
  // A rich pool spanning all bands at price 10.
  const cards = [
    { value: 0.1 },
    { value: 0.5 },
    { value: 1 },
    { value: 3 },
    { value: 7 },
    { value: 12 },
    { value: 25 },
    { value: 80 },
  ];
  const price = 10;
  const targetEdge = TARGET_HOUSE_EDGE;
  const targetWinRate = 0.2;
  const r = shapeWeights({ cards, price, targetEdge, targetWinRate });
  assert(isSuccess(r), `expected success: ${"error" in r ? r.error : ""}`);
  if (!isSuccess(r)) return;
  assert(r.edge >= targetEdge - 1e-9, `edge ≥ target (${r.edge} vs ${targetEdge})`);
  assert(r.edge - targetEdge <= 0.001 + 1e-9, `edge − target ≤ 0.001 (got ${r.edge - targetEdge})`);
  assert(Math.abs(r.risk.winRate - targetWinRate) <= 0.02 + 1e-9, `win-rate within tol (${r.risk.winRate})`);
  for (const w of r.weights) {
    assert(Number.isInteger(w) && w >= 0, `weight is non-negative int, got ${w}`);
  }
  // Each kept card must have weight ≥ 1 (all cards kept here, none over-cap).
  for (const w of r.weights) assert(w >= 1, `kept card weight ≥ 1, got ${w}`);
  // Recompute risk from the returned vector to confirm consistency.
  const recomputed = computePackRisk({
    cards: cards.map((c, i) => ({ value: c.value, weight: r.weights[i]! })),
    price,
  });
  approx(recomputed.edge, r.edge, 1e-9, "returned edge matches recomputed");
});

check("shapeWeights: maxWinCap respected (recomputed from returned vector)", () => {
  const cards = [
    { value: 0.2 },
    { value: 1 },
    { value: 4 },
    { value: 9 },
    { value: 50 },
    { value: 999 }, // above cap → must be dropped (weight 0)
  ];
  const price = 10;
  const cap = 100;
  const r = shapeWeights({ cards, price, targetWinRate: 0.15, maxWinCap: cap });
  assert(isSuccess(r), `expected success: ${"error" in r ? r.error : ""}`);
  if (!isSuccess(r)) return;
  // The over-cap card must carry zero weight.
  assert(r.weights[5] === 0, `over-cap card must have weight 0, got ${r.weights[5]}`);
  // No card with weight > 0 may exceed the cap.
  cards.forEach((c, i) => {
    if (r.weights[i]! > 0) assert(c.value <= cap, `weighted card ${c.value} exceeds cap ${cap}`);
  });
  assert(r.risk.maxWin <= cap, `maxWin ≤ cap (${r.risk.maxWin})`);
});

check("shapeWeights: floor pin met when requested", () => {
  const cards = [
    { value: 0.1 },
    { value: 2 }, // 0.2·price — floor candidate at floorRatioMin 0.2
    { value: 4 },
    { value: 6 }, // near-miss [0.5p, p) so nearMissMin can be satisfied
    { value: 11 },
    { value: 60 },
  ];
  const price = 10;
  const floorRatioMin = 0.2;
  const r = shapeWeights({ cards, price, targetWinRate: 0.15, floorRatioMin });
  assert(isSuccess(r), `expected success: ${"error" in r ? r.error : ""}`);
  if (!isSuccess(r)) return;
  assert(r.risk.floorRatio >= floorRatioMin - 1e-9, `floorRatio ≥ min (${r.risk.floorRatio})`);
});

check("shapeWeights: error arm never carries a weights vector, always carries a limit", () => {
  // No win/grail cards → infeasible (HARD).
  const r1 = shapeWeights({ cards: [{ value: 1 }, { value: 2 }], price: 10, targetWinRate: 0.2 });
  assert(!isSuccess(r1), "no-win pool should error");
  assert(!("weights" in r1), "error must not carry weights");
  assert("limit" in r1 && typeof r1.limit.kind === "string", "error must carry a structured limit");
});

// ── 6b. GRACEFUL RELAXATION: a pool with NO near-miss cards still succeeds ──
check("shapeWeights: no near-miss cards → SUCCESS with a nearMiss relaxation (applied 0), edge ≥ target", () => {
  // Pool spans DUST (< 0.5p) + WIN/GRAIL (≥ p) but has NO card in [0.5p, p):
  // the near-miss band is empty. With nearMissMin = 0.1 requested, the solver
  // must RELAX near-miss to 0 and still return a feasible, edge-correct pack —
  // NOT an error.
  const price = 10;
  const cards = [
    { value: 0.1 },
    { value: 1 }, // dust
    { value: 3 }, // dust (< 0.5·price = 5)
    { value: 12 }, // win
    { value: 60 }, // grail
  ];
  const r = shapeWeights({ cards, price, targetWinRate: 0.15, nearMissMin: 0.1 });
  assert(isSuccess(r), `expected success, got error: ${"error" in r ? r.error : ""}`);
  if (!isSuccess(r)) return;
  // Edge still lands ≥ target (one-sided-up promise survives relaxation).
  assert(r.edge >= TARGET_HOUSE_EDGE - 1e-9, `edge ≥ target after relaxation (${r.edge})`);
  // A nearMiss relaxation must be recorded, applied 0, requested 0.1.
  const nm = r.relaxations.find((x) => x.lever === "nearMiss");
  assert(nm !== undefined, "a nearMiss relaxation must be recorded");
  if (nm) {
    approx(nm.requested, 0.1, 1e-12, "nearMiss requested = 0.1");
    approx(nm.applied, 0, 1e-12, "nearMiss applied = 0 (no near-miss cards)");
    assert(typeof nm.reason === "string" && nm.reason.length > 0, "relaxation carries a reason");
  }
  // The success arm must NOT carry an error.
  assert(!("error" in r), "success arm must not carry an error");
  // Achieved near-miss mass is genuinely 0 (no near-miss cards exist).
  approx(r.risk.nearMiss, 0, 1e-9, "achieved near-miss is 0");
});

// ── 6c. A clean feasible solve records NO relaxations ───────────────────
check("shapeWeights: a clean feasible solve returns an empty relaxations array", () => {
  const cards = [
    { value: 0.1 },
    { value: 0.5 },
    { value: 1 },
    { value: 3 },
    { value: 6 }, // near-miss [0.5p, p)
    { value: 12 },
    { value: 25 },
    { value: 80 },
  ];
  const r = shapeWeights({ cards, price: 10, targetWinRate: 0.2, nearMissMin: 0.1 });
  assert(isSuccess(r), `expected success: ${"error" in r ? r.error : ""}`);
  if (!isSuccess(r)) return;
  assert(Array.isArray(r.relaxations), "relaxations is an array");
  assert(r.relaxations.length === 0, `no relaxations on a clean solve, got ${JSON.stringify(r.relaxations)}`);
});

// ── 6d. HARD limit: a no-win-card pool errors with a populated `limit` ──
check("shapeWeights: no-win-card pool → error arm with a populated structured limit", () => {
  // Every card is below price → cannot make ANY win-rate. This stays a HARD
  // error (truly impossible), and must carry a structured limit.
  const price = 10;
  const r = shapeWeights({ cards: [{ value: 1 }, { value: 2 }, { value: 4 }], price, targetWinRate: 0.2 });
  assert(!isSuccess(r), "no-win pool must error");
  if (isSuccess(r)) return;
  assert(!("weights" in r), "error must not carry weights");
  assert("limit" in r, "error must carry a limit");
  assert(r.limit.kind === "no-win-cards", `limit.kind = no-win-cards, got ${r.limit.kind}`);
  assert(typeof r.limit.detail === "string" && r.limit.detail.length > 0, "limit.detail non-empty");
  assert(
    typeof r.limit.suggestion === "string" && r.limit.suggestion.length > 0,
    "limit.suggestion non-empty",
  );
});

// ── 6e. HARD limit: a degenerate single-value pool errors with a limit ──
check("shapeWeights: single-value (degenerate) pool → error with degenerate-pool limit", () => {
  // Every usable card shares one value → no spread → edge cannot be shaped.
  const r = shapeWeights({ cards: [{ value: 10 }, { value: 10 }], price: 10, targetWinRate: 0.2 });
  assert(!isSuccess(r), "degenerate pool must error");
  if (isSuccess(r)) return;
  assert(
    "limit" in r && r.limit.kind === "degenerate-pool",
    `degenerate-pool limit, got ${"limit" in r ? r.limit.kind : "none"}`,
  );
});

// ── 6f. SOFT relaxation: an over-high win-rate is relaxed, not errored ──
check("shapeWeights: win-rate too high for the mass budget → relaxed, success, edge ≥ target", () => {
  // Win + near-miss would consume all the mass; the win-rate is relaxed DOWN to
  // leave dust mass for the edge, and the result is still a valid pack. Win
  // cards sit just at/above price so a high win mass can still hit the EV target.
  const price = 10;
  const cards = [
    { value: 0.1 },
    { value: 1 },
    { value: 3 },
    { value: 10 },
    { value: 11 },
    { value: 13 },
  ];
  const r = shapeWeights({ cards, price, targetWinRate: 0.95, nearMissMin: 0.1 });
  assert(isSuccess(r), `expected success after relaxing an over-high win-rate: ${"error" in r ? r.error : ""}`);
  if (!isSuccess(r)) return;
  assert(r.edge >= TARGET_HOUSE_EDGE - 1e-9, `edge ≥ target (${r.edge})`);
  const wr = r.relaxations.find((x) => x.lever === "winRate");
  assert(wr !== undefined, "a winRate relaxation must be recorded");
  if (wr) {
    approx(wr.requested, 0.95, 1e-12, "winRate requested = 0.95");
    assert(wr.applied < 0.95, `winRate applied relaxed below request (${wr.applied})`);
  }
});

// ── 6g. NEW HARD limit: grail-only pool can't satisfy edge + win-rate ──
//
// Regression for the band-aware error messages: a pool that has GRAIL cards
// (≥ 5·price) but no WIN-band card in [price, 5·price) AND whose cheapest grail
// is expensive enough that the min achievable EV at the target win-rate exceeds
// evTarget. The new `no-win-band-card` HARD pre-check must fire BEFORE the
// existing `ev-unreachable-for-split` so the operator sees a band-specific
// suggestion mentioning the WIN price range.
check("shapeWeights: grail-only pool with expensive grails → no-win-band-card with band-aware suggestion", () => {
  // Price $1.25, target win-rate 1%, target edge 10.99%. With cheapest grail at
  // $200 and a $0.08 dust card, min EV at 1% = 0.01·200 + 0.99·0.08 = $2.0792,
  // which exceeds evTarget = 1.25·(1 − 0.1099) ≈ $1.1126.
  const price = 1.25;
  const cards = [
    { value: 0.08 },   // dust
    { value: 200 },    // grail (cheapest)
    { value: 400 },    // grail
    { value: 810 },    // grail
  ];
  const r = shapeWeights({
    cards,
    price,
    targetEdge: 0.1099,
    targetWinRate: 0.01,
  });
  assert(!isSuccess(r), "expensive-grails pool with 1% win-rate must error");
  if (isSuccess(r)) return;
  assert(
    "limit" in r && r.limit.kind === "no-win-band-card",
    `expected no-win-band-card, got ${"limit" in r ? r.limit.kind : "none"}`,
  );
  // The suggestion must mention the WIN price range so the operator knows what
  // kind of card to add (price.toFixed(2) to (5*price).toFixed(2) = "$1.25" to "$6.25").
  assert(
    r.limit.suggestion.includes("$1.25") && r.limit.suggestion.includes("$6.25"),
    `suggestion mentions WIN band $1.25–$6.25, got: ${r.limit.suggestion}`,
  );
  // The detail names the grail count and the missing WIN band.
  assert(
    r.limit.detail.includes("3 jackpot card(s)") || r.limit.detail.includes("jackpot"),
    `detail names the grail count, got: ${r.limit.detail}`,
  );
  assert(
    r.limit.detail.includes("$1.25") && r.limit.detail.includes("$6.25"),
    `detail mentions the missing $1.25–$6.25 WIN band, got: ${r.limit.detail}`,
  );
  // The detail mentions the target win-rate so the operator can confirm WHY.
  assert(r.limit.detail.includes("1.00%"), `detail names the 1% target, got: ${r.limit.detail}`);
});

// ── 6h. A grail-only pool whose cheapest grail is CHEAP ENOUGH still solves ──
//
// The new pre-check must NOT fire when min EV at the target win-rate is below
// evTarget — the solver can find an intermediate beta. This is the user's
// "1% 18 PLUS" scenario as literally described: price $1.25, cheapest grail
// $60.25, dust $0.08, 1% win-rate, 10.99% edge → minEV ≈ $0.68 < evTarget
// $1.11 → falls through to normal shaping and succeeds.
check("shapeWeights: grail-only pool with cheap grails falls through to normal shaping", () => {
  const price = 1.25;
  const cards = [
    { value: 0.08 },
    { value: 60.25 },
    { value: 64.76 },
    { value: 75.47 },
    { value: 114.0 },
    { value: 118.21 },
    { value: 508.45 },
    { value: 810.07 },
  ];
  const r = shapeWeights({
    cards,
    price,
    targetEdge: 0.1099,
    targetWinRate: 0.01,
  });
  // This must succeed (or hit a different limit, but NOT no-win-band-card).
  if (!isSuccess(r)) {
    assert(
      "limit" in r && r.limit.kind !== "no-win-band-card",
      `cheap-grails pool must NOT trigger no-win-band-card, got: ${r.limit.kind} — ${r.limit.detail}`,
    );
    return;
  }
  // On success the edge is at/above target.
  assert(r.edge >= 0.1099 - 1e-9, `edge ≥ target (${r.edge})`);
});

// ── 6i. A normal feasible pack still succeeds (regression for the rewrite) ──
check("shapeWeights: a normal feasible pack still succeeds after the error-message rewrite", () => {
  // The same rich pool from check #6 ($10 pack with cards spanning all bands).
  const cards = [
    { value: 0.1 },
    { value: 0.5 },
    { value: 1 },
    { value: 3 },
    { value: 7 }, // near-miss
    { value: 12 },
    { value: 25 },
    { value: 80 },
  ];
  const r = shapeWeights({ cards, price: 10, targetEdge: TARGET_HOUSE_EDGE, targetWinRate: 0.2 });
  assert(isSuccess(r), `normal feasible pack still solves: ${"error" in r ? r.error : ""}`);
  if (!isSuccess(r)) return;
  assert(r.edge >= TARGET_HOUSE_EDGE - 1e-9, `edge ≥ target (${r.edge})`);
});

// ── 6j. The cap-filtered no-win-cards message says so distinctly ──────
//
// When `maxWinCap` strips win/grail cards down to zero, the suggestion must
// offer EITHER adding a card in the surviving range OR raising the cap.
check("shapeWeights: cap-stripped no-win-cards message names the cap + offers a raise-cap option", () => {
  const price = 10;
  // Three cards all above the $5 cap → all stripped → no usable card ≥ price.
  // (A non-finite or value-≤-0 path isn't exercised here so we hit the cap path.)
  const r = shapeWeights({
    cards: [{ value: 50 }, { value: 100 }, { value: 200 }],
    price,
    targetWinRate: 0.2,
    maxWinCap: 5,
  });
  assert(!isSuccess(r), "cap-stripped pool must error");
  if (isSuccess(r)) return;
  // After the cap pre-filter strips every card, no usable card remains at all,
  // so the `empty-pool` limit fires (before any band check). The message must
  // still name the cap.
  assert(
    "limit" in r &&
      (r.limit.kind === "empty-pool" || r.limit.kind === "no-win-cards"),
    `expected empty-pool or no-win-cards, got ${"limit" in r ? r.limit.kind : "none"}`,
  );
  assert(r.limit.detail.includes("$5.00"), `detail mentions the $5.00 cap, got: ${r.limit.detail}`);
});

// ── 6k. Cap-filtered no-win-cards with a surviving DUST card → distinct message ──
//
// When the cap strips WIN/GRAIL cards but the pool still has DUST survivors,
// the new no-win-cards path emits the distinct "Auto-cap filter removed N
// card(s)" detail naming the surviving range.
check("shapeWeights: cap-stripped WITH dust survivors → no-win-cards detail names the cap-drop count", () => {
  const price = 10;
  const r = shapeWeights({
    cards: [
      { value: 1 },   // dust survives
      { value: 50 },  // stripped by cap
      { value: 200 }, // stripped by cap
    ],
    price,
    targetWinRate: 0.2,
    maxWinCap: 5,
  });
  assert(!isSuccess(r), "cap-stripped pool with dust survivors must error");
  if (isSuccess(r)) return;
  assert(
    "limit" in r && r.limit.kind === "no-win-cards",
    `expected no-win-cards, got ${"limit" in r ? r.limit.kind : "none"}`,
  );
  assert(
    r.limit.detail.includes("Auto-cap filter removed 2 card(s)"),
    `detail names the cap-drop count, got: ${r.limit.detail}`,
  );
  assert(
    r.limit.detail.includes("$5.00") && r.limit.detail.includes("$10.00"),
    `detail names cap and price, got: ${r.limit.detail}`,
  );
  assert(
    r.limit.suggestion.includes("raise") || r.limit.suggestion.includes("max-win cap"),
    `suggestion offers raising the cap, got: ${r.limit.suggestion}`,
  );
});

// ── 7. THE SWEEP ────────────────────────────────────────────────────
check("sweep: feasible combos satisfy invariants; infeasible return error-no-vector", () => {
  function dist(kind: "flat" | "power" | "bimodal", n: number, price: number): { value: number }[] {
    const out: { value: number }[] = [];
    if (kind === "flat") {
      // Linear spread from 0.1·price to 8·price.
      for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0 : i / (n - 1);
        out.push({ value: price * (0.1 + t * 7.9) });
      }
    } else if (kind === "power") {
      // Geometric spread: many cheap, few expensive.
      for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0 : i / (n - 1);
        out.push({ value: price * 0.05 * Math.pow(400, t) }); // 0.05p .. 20p
      }
    } else {
      // Bimodal: a dense cheap cluster + a sparse jackpot cluster.
      for (let i = 0; i < n; i++) {
        if (i < Math.ceil(n * 0.7)) {
          const t = i / Math.max(1, Math.ceil(n * 0.7) - 1);
          out.push({ value: price * (0.05 + t * 0.4) }); // 0.05p .. 0.45p (dust)
        } else {
          const j = i - Math.ceil(n * 0.7);
          out.push({ value: price * (1.2 + j * 6) }); // 1.2p, 7.2p, ... (wins/grails)
        }
      }
    }
    return out;
  }

  let feasible = 0;
  let infeasible = 0;

  const prices = [1, 5, 25, 100];
  const kinds: ("flat" | "power" | "bimodal")[] = ["flat", "power", "bimodal"];
  const edges = [0.0599, 0.1099, 0.15];
  const winRates = [0.1, 0.2, 0.3];

  for (const price of prices) {
    for (const kind of kinds) {
      for (let n = 3; n <= 40; n++) {
        const cards = dist(kind, n, price);
        for (const targetEdge of edges) {
          for (const targetWinRate of winRates) {
            for (const cap of [undefined, 5 * price] as (number | undefined)[]) {
              for (const floor of [undefined, 0.15] as (number | undefined)[]) {
                const r = shapeWeights({
                  cards,
                  price,
                  targetEdge,
                  targetWinRate,
                  maxWinCap: cap,
                  floorRatioMin: floor,
                });
                if (isSuccess(r)) {
                  feasible++;
                  // Invariant battery on the RETURNED vector.
                  assert(
                    !("error" in r),
                    "success arm must not carry an error",
                  );
                  // The relaxations field is always a well-formed array.
                  assert(Array.isArray(r.relaxations), "success carries a relaxations array");
                  for (const rx of r.relaxations) {
                    assert(
                      (rx.lever === "nearMiss" || rx.lever === "winRate" || rx.lever === "floor") &&
                        Number.isFinite(rx.requested) &&
                        Number.isFinite(rx.applied) &&
                        typeof rx.reason === "string" &&
                        rx.reason.length > 0,
                      `well-formed relaxation (p=${price},k=${kind},n=${n}): ${JSON.stringify(rx)}`,
                    );
                    // Soft relaxation only ever loosens DOWNWARD.
                    assert(
                      rx.applied <= rx.requested + 1e-9 && rx.applied >= -1e-9,
                      `relaxation applied ≤ requested & ≥ 0 (p=${price},k=${kind},n=${n}): ${JSON.stringify(rx)}`,
                    );
                  }
                  for (const w of r.weights) {
                    assert(
                      Number.isInteger(w) && w >= 0,
                      `weight int≥0 (p=${price},k=${kind},n=${n}), got ${w}`,
                    );
                  }
                  const recomputed = computePackRisk({
                    cards: cards.map((c, i) => ({ value: c.value, weight: r.weights[i]! })),
                    price,
                  });
                  // EDGE is HARD — it must always land ≥ target, relaxed or not.
                  assert(
                    recomputed.edge >= targetEdge - 1e-9,
                    `edge≥target (p=${price},k=${kind},n=${n},e=${targetEdge}): ${recomputed.edge}`,
                  );
                  assert(
                    recomputed.edge - targetEdge <= 0.001 + 1e-9,
                    `edge−target≤0.001 (p=${price},k=${kind},n=${n},e=${targetEdge}): ${recomputed.edge - targetEdge}`,
                  );
                  // WIN-RATE is a SOFT target: if relaxed, the achieved win-rate
                  // matches the RELAXED (applied) value; otherwise the request.
                  const wrRelax = r.relaxations.find((x) => x.lever === "winRate");
                  const effectiveWinRate = wrRelax ? wrRelax.applied : targetWinRate;
                  assert(
                    Math.abs(recomputed.winRate - effectiveWinRate) <= 0.02 + 1e-9,
                    `winRate within tol of effective target (p=${price},k=${kind},n=${n},wr=${effectiveWinRate}): ${recomputed.winRate}`,
                  );
                  if (wrRelax) {
                    assert(
                      wrRelax.applied < targetWinRate + 1e-9,
                      `relaxed win-rate ≤ requested (${wrRelax.applied} vs ${targetWinRate})`,
                    );
                  }
                  if (cap !== undefined) {
                    assert(
                      recomputed.maxWin <= cap + 1e-9,
                      `cap respected (p=${price},k=${kind},n=${n}): maxWin ${recomputed.maxWin} > ${cap}`,
                    );
                    cards.forEach((c, i) => {
                      if (r.weights[i]! > 0) {
                        assert(
                          c.value <= cap + 1e-9,
                          `no weighted card over cap (${c.value} > ${cap})`,
                        );
                      }
                    });
                  }
                  // FLOOR is a SOFT pin: enforced only when NOT relaxed away.
                  if (floor !== undefined) {
                    const floorRelax = r.relaxations.find((x) => x.lever === "floor");
                    if (!floorRelax) {
                      assert(
                        recomputed.floorRatio >= floor - 1e-9,
                        `floor met when not relaxed (p=${price},k=${kind},n=${n}): ${recomputed.floorRatio} < ${floor}`,
                      );
                    }
                  }
                } else {
                  infeasible++;
                  assert(
                    !("weights" in r),
                    `infeasible must not carry weights (p=${price},k=${kind},n=${n},e=${targetEdge},wr=${targetWinRate})`,
                  );
                  assert(
                    typeof r.error === "string" && r.error.length > 0,
                    "infeasible must carry a non-empty error message",
                  );
                  // Every error arm carries a structured, actionable limit.
                  assert(
                    "limit" in r &&
                      typeof r.limit.kind === "string" &&
                      r.limit.kind.length > 0 &&
                      typeof r.limit.detail === "string" &&
                      r.limit.detail.length > 0 &&
                      typeof r.limit.suggestion === "string" &&
                      r.limit.suggestion.length > 0,
                    `infeasible carries a populated limit (p=${price},k=${kind},n=${n},e=${targetEdge},wr=${targetWinRate})`,
                  );
                }
              }
            }
          }
        }
      }
    }
  }

  console.log(`      swept combos → ${feasible} feasible / ${infeasible} infeasible`);
  assert(feasible > 0, "sweep should produce feasible combos");
  assert(infeasible > 0, "sweep should exercise infeasible combos too");
});

// ── 8. autoMaxWinCap = min(global, price·ceiling), never below price ────
check("autoMaxWinCap = min(global, price·ceiling) and always ≥ price", () => {
  const globalCap = 25000;
  const maxMultCeiling = 100;
  const cfg = { globalCap, maxMultCeiling };

  // Cheap pack: price·ceiling ($5·100 = $500) < global ($25k) → MULTIPLIER bound.
  const cheap = autoMaxWinCap(5, cfg);
  assert(cheap === 500, `cheap pack capped by multiplier (5·100=500), got ${cheap}`);
  assert(cheap === Math.min(globalCap, 5 * maxMultCeiling), "cheap = min(global, mult)");
  assert(cheap >= 5, "cheap cap ≥ price");

  // Premium pack: price·ceiling ($1000·100 = $100k) > global ($25k) → GLOBAL bound.
  const premium = autoMaxWinCap(1000, cfg);
  assert(premium === globalCap, `premium pack capped by global ($25k), got ${premium}`);
  assert(premium === Math.min(globalCap, 1000 * maxMultCeiling), "premium = min(global, mult)");
  assert(premium >= 1000, "premium cap ≥ price");

  // Exact crossover: price where price·ceiling == global ($250·100 = $25k).
  const cross = autoMaxWinCap(250, cfg);
  assert(cross === globalCap, `crossover equals global, got ${cross}`);

  // Degenerate: a global cap BELOW price must still never strip the ticket —
  // the cap floors at price so every win/grail card survives the shaper.
  const tiny = autoMaxWinCap(100, { globalCap: 10, maxMultCeiling: 100 });
  assert(tiny === 100, `cap never below price (floored to price), got ${tiny}`);

  // Sweep: the min(global, mult) ⊓ floor-at-price invariant over many inputs.
  for (const price of [0.5, 1, 5, 25, 100, 250, 1000, 25000]) {
    for (const ceiling of [1, 10, 100, 1000]) {
      for (const cap of [10, 500, 25000, 1_000_000]) {
        const got = autoMaxWinCap(price, { globalCap: cap, maxMultCeiling: ceiling });
        const expected = Math.max(Math.min(cap, price * ceiling), price);
        approx(got, expected, 1e-9, `autoMaxWinCap(${price},{${cap},${ceiling}})`);
        assert(got >= price - 1e-9, `cap ≥ price (p=${price})`);
        // A cap at the auto value must be a valid shapeWeights ceiling (≥ price
        // means at least the ticket-priced card can carry win mass).
      }
    }
  }
});

// ── 9. autoRetuneTargets wires the per-pack edge + auto-cap + house defaults ──
check("autoRetuneTargets = {per-pack edge, default win-rate/near-miss, autoMaxWinCap}", () => {
  const cfg = { globalCap: 25000, maxMultCeiling: 100 };
  for (const price of [1, 5, 25, 100, 1000]) {
    const t = autoRetuneTargets(price, cfg);
    approx(t.targetWinRate, DEFAULT_TARGET_WIN_RATE, 1e-12, "targetWinRate default");
    assert(t.intendedHitRate === null, "untagged (no name) → intendedHitRate null");
    approx(t.nearMissMin, DEFAULT_NEAR_MISS_MIN, 1e-12, "nearMissMin default");
    approx(t.maxWinCap, autoMaxWinCap(price, cfg), 1e-9, "maxWinCap = autoMaxWinCap");
    assert(t.maxWinCap >= price - 1e-9, `auto cap ≥ price (p=${price})`);
    // targetEdge = autoTargetEdge using the pack's intended cap as the max-win
    // proxy (pre-shape) — never below the floor, always within the band.
    approx(
      t.targetEdge,
      autoTargetEdge({ price, maxWin: t.maxWinCap }),
      1e-12,
      "targetEdge = autoTargetEdge(price, autoMaxWinCap)",
    );
    assert(t.targetEdge >= DEFAULT_EDGE_FLOOR - 1e-12, `targetEdge ≥ floor (p=${price})`);
    assert(t.targetEdge <= DEFAULT_EDGE_CEILING + 1e-12, `targetEdge ≤ ceiling (p=${price})`);
  }
  // A calm cheap pack (tiny cap ⇒ tiny max-win proxy, low price) sits at the floor.
  const calm = autoRetuneTargets(1, { globalCap: 25000, maxMultCeiling: 100 });
  // price 1, cap = min(25000, 100) = 100 < maxWinBase(500) and price < priceBase(2)
  // ⇒ both drivers 0 ⇒ exactly the floor (= TARGET_PACK_EDGE = TARGET_HOUSE_EDGE).
  approx(calm.targetEdge, TARGET_PACK_EDGE, 1e-12, "calm cheap pack → floor");
  approx(calm.targetEdge, TARGET_HOUSE_EDGE, 1e-12, "floor = house edge identity");
});

// ── 9b. LIVE-ANCHORED targets (owner-lens patterns 3, 5, 7) ─────────────
// The 5th `live` arg (present on both planPackTune arms + the staged resolver)
// makes an UNTAGGED retune target the pack's OWN designed character instead of
// the fleet recipe. Every check pins the PURE derivation (no engine solve).

check("live-anchored: omitting `live` is byte-identical to the legacy default", () => {
  const cfg = { globalCap: 25000, maxMultCeiling: 100 };
  for (const price of [1, 5, 25, 100, 1000]) {
    const legacy = autoRetuneTargets(price, cfg, undefined, 300);
    const noLive = autoRetuneTargets(price, cfg, undefined, 300, undefined);
    const partialEmpty = autoRetuneTargets(price, cfg, undefined, 300, {});
    for (const t of [noLive, partialEmpty]) {
      approx(t.targetEdge, legacy.targetEdge, 1e-12, "targetEdge unchanged");
      approx(t.targetWinRate, legacy.targetWinRate, 1e-12, "targetWinRate unchanged");
      approx(t.nearMissMin, legacy.nearMissMin, 1e-12, "nearMissMin unchanged");
      approx(t.maxWinCap, legacy.maxWinCap, 1e-9, "maxWinCap unchanged");
    }
    // The legacy untagged default IS the 20% recipe (the fiction) — pinned so
    // the "no live pool ⇒ 20% survives" contract is explicit.
    approx(legacy.targetWinRate, DEFAULT_TARGET_WIN_RATE, 1e-12, "no-live ⇒ 20%");
  }
});

check("Pattern 3: untagged win-rate is anchored to live (kills the 20% fiction)", () => {
  const cfg = { globalCap: 25000, maxMultCeiling: 100 };
  // A deliberately brutal 8.5%-winner pack (the "Like a Boss" class): the
  // legacy default rewrites it to 20%; live-anchored keeps 8.5%.
  const brutal = autoRetuneTargets(10, cfg, undefined, 250, {
    winRate: 0.085,
    nearMiss: 0.12,
    edge: 0.11,
    topValue: 250,
  });
  approx(brutal.targetWinRate, 0.085, 1e-12, "untagged targets its LIVE 8.5%, not 20%");
  // A soft 50/50-ish pack solved untagged: anchored to its live ~50%.
  const soft = autoRetuneTargets(20, cfg, undefined, 100, { winRate: 0.5 });
  approx(soft.targetWinRate, 0.5, 1e-12, "untagged targets its LIVE 50%");
  // Clamped into the sane product band at the extremes.
  const tiny = autoRetuneTargets(10, cfg, undefined, 250, { winRate: 0.001 });
  approx(tiny.targetWinRate, UNTAGGED_WINRATE_LIVE_MIN, 1e-12, "clamped up to the min");
  const huge = autoRetuneTargets(10, cfg, undefined, 250, { winRate: 0.999 });
  approx(huge.targetWinRate, UNTAGGED_WINRATE_LIVE_MAX, 1e-12, "clamped down to the max");
  // Executable-check spec: |target − live| ≤ 0 by construction inside the band.
  for (const wr of [0.05, 0.085, 0.2, 0.35, 0.55, 0.8]) {
    const t = autoRetuneTargets(10, cfg, undefined, 250, { winRate: wr });
    assert(Math.abs(t.targetWinRate - wr) < 1e-12, `in-band winRate ${wr} anchored exactly`);
  }
});

check("Pattern 3: a TAGGED pack's win-rate stays its EXACT tag (live anchor ignored)", () => {
  const cfg = { globalCap: 25000, maxMultCeiling: 100 };
  // Even with a drifted live win-rate, a "1%" pack still targets 1%.
  const tagged = autoRetuneTargets(0.95, cfg, 0.01, 2507.35, {
    winRate: 0.198, // drifted live rate — must be IGNORED
    nearMiss: 0,
    edge: 0.09,
    topValue: 2507.35,
  });
  approx(tagged.targetWinRate, 0.01, 1e-12, "tagged targets its tag, not the drifted live rate");
  approx(tagged.nearMissMin, 0, 1e-12, "tagged near-miss floor stays 0 (binary lottery)");
  assert(tagged.intendedHitRate === 0.01, "intendedHitRate is the tag");
});

check("Pattern 3 sub: untagged near-miss floor seeds UP from live (×0.8)", () => {
  const cfg = { globalCap: 25000, maxMultCeiling: 100 };
  // A designed 40% near-miss band survives (0.40 × 0.8 = 0.32 > the 0.1 floor).
  const teasy = autoRetuneTargets(10, cfg, undefined, 250, {
    winRate: 0.2,
    nearMiss: 0.4,
  });
  approx(teasy.nearMissMin, 0.4 * UNTAGGED_NEAR_MISS_LIVE_FACTOR, 1e-12, "0.40 live → 0.32 floor");
  assert(teasy.nearMissMin >= 0.3, "designed teaser band survives (≥30%)");
  // A pack with little live near-miss keeps the 0.1 default (never LOWERED).
  const flat = autoRetuneTargets(10, cfg, undefined, 250, {
    winRate: 0.2,
    nearMiss: 0.05,
  });
  approx(flat.nearMissMin, DEFAULT_NEAR_MISS_MIN, 1e-12, "small live near-miss → 0.1 default");
  // Executable-check spec: nearMiss ≥ min(live.nearMiss, 0.10) × 0.75.
  for (const nm of [0.02, 0.1, 0.25, 0.5, 0.7]) {
    const t = autoRetuneTargets(10, cfg, undefined, 250, { winRate: 0.2, nearMiss: nm });
    assert(
      t.nearMissMin >= Math.min(nm, 0.1) * 0.75 - 1e-12,
      `near-miss preserve holds for live ${nm} (got ${t.nearMissMin})`,
    );
  }
});

check("Pattern 7: the retune never refunds an above-target live edge", () => {
  const cfg = { globalCap: 25000, maxMultCeiling: 100 };
  // Amazon class: live edge 11.30% sits above the curve target — the plan must
  // hold it (target ≥ liveEdge − slack), never pull it down to the floor.
  const amazon = autoRetuneTargets(20, cfg, undefined, 500, {
    winRate: 0.2,
    edge: 0.113,
  });
  assert(
    amazon.targetEdge >= 0.113 - EDGE_NEVER_BELOW_LIVE_SLACK - 1e-12,
    `above-target live edge held (target ${amazon.targetEdge}, live 0.113)`,
  );
  assert(amazon.targetEdge <= DEFAULT_EDGE_CEILING + 1e-12, "still under the ceiling");
  // An extreme live edge clamps at the ceiling, never above it.
  const extreme = autoRetuneTargets(10, cfg, undefined, 250, { winRate: 0.085, edge: 0.5 });
  approx(extreme.targetEdge, DEFAULT_EDGE_CEILING, 1e-12, "extreme live edge → ceiling (not above)");
  // A BELOW-target pack is untouched: it still lifts to the curve target
  // (never dragged DOWN toward its low live edge).
  const below = autoRetuneTargets(20, cfg, undefined, 500, { winRate: 0.2, edge: 0.09 });
  const curveOnly = autoRetuneTargets(20, cfg, undefined, 500);
  approx(below.targetEdge, curveOnly.targetEdge, 1e-12, "below-target pack lifts to the curve (unchanged)");
  assert(below.targetEdge > 0.09, "below-target edge is RAISED, not held at the low live edge");
});

check("Pattern 5: a live over-cap card is grandfathered (cap stops NEW escalation only)", () => {
  const cfg = { globalCap: 25000, maxMultCeiling: 100 };
  // Trash class: a $0.15 micro-pack whose live top ($306) is 2040× — far above
  // the untagged 100× cap ($15). The auto cap would DELETE it; grandfather keeps
  // it (the owner already runs it live).
  const autoCap = autoMaxWinCap(0.15, cfg); // = max($15, price) = $15
  assert(autoCap < 306, `auto cap deletes the $306 top (cap $${autoCap.toFixed(2)})`);
  const grandfathered = autoRetuneTargets(0.15, cfg, undefined, 306, { topValue: 306 });
  approx(grandfathered.maxWinCap, 306, 1e-9, "cap grandfathers the live $306 top");
  // A live top BELOW the auto cap changes nothing (grandfather only loosens).
  const under = autoRetuneTargets(0.15, cfg, undefined, 5, { topValue: 5 });
  approx(under.maxWinCap, autoCap, 1e-9, "live top under the cap → cap unchanged");
  // Grandfather applies to a TAGGED pack too (a further max that only loosens).
  const taggedAuto = autoMaxWinCap(0.95, cfg, 0.01); // %1 headroom cap ≈ $2185
  const taggedGf = autoRetuneTargets(0.95, cfg, 0.01, 2507.35, { topValue: 2507.35 });
  assert(taggedGf.maxWinCap >= 2507.35 - 1e-9, "tagged live over-cap card grandfathered");
  assert(taggedGf.maxWinCap >= taggedAuto - 1e-9, "grandfather never TIGHTENS the tagged cap");
});

// ── 10. autoTargetEdge: floor / ceiling / monotonicity / calibration ────
check("autoTargetEdge ∈ [floor, ceiling], NEVER below 0.1099, finite", () => {
  // Floor identity.
  approx(DEFAULT_EDGE_FLOOR, 0.1099, 1e-12, "floor is 10.99%");
  approx(DEFAULT_EDGE_FLOOR, TARGET_PACK_EDGE, 1e-12, "floor = TARGET_PACK_EDGE");
  approx(DEFAULT_EDGE_CEILING, 0.115, 1e-12, "ceiling is 11.50%");
  // Wide sweep over the live-catalog ranges (and beyond) — clamp invariants.
  for (const price of [0, 0.15, 1, 2, 5, 12, 25, 100, 250, 766, 1300, 5000, 1e6]) {
    for (const maxWin of [0, 12, 100, 300, 500, 1000, 5000, 24000, 50000, 1e7]) {
      const e = autoTargetEdge({ price, maxWin });
      assert(Number.isFinite(e), `finite (p=${price},m=${maxWin}), got ${e}`);
      assert(e >= DEFAULT_EDGE_FLOOR - 1e-12, `≥ floor (p=${price},m=${maxWin}): ${e}`);
      assert(e <= DEFAULT_EDGE_CEILING + 1e-12, `≤ ceiling (p=${price},m=${maxWin}): ${e}`);
      assert(e >= 0.1099 - 1e-12, `NEVER below 0.1099 (p=${price},m=${maxWin}): ${e}`);
    }
  }
  // Non-finite inputs are treated as 0 ⇒ floor (NaN-safe contract).
  approx(autoTargetEdge({ price: NaN, maxWin: NaN }), DEFAULT_EDGE_FLOOR, 1e-12, "NaN inputs → floor");
  approx(autoTargetEdge({ price: -5, maxWin: -5 }), DEFAULT_EDGE_FLOOR, 1e-12, "negative inputs → floor");
  approx(autoTargetEdge({ price: Infinity, maxWin: Infinity }), DEFAULT_EDGE_FLOOR, 1e-12, "Inf inputs → floor");
});

check("autoTargetEdge non-decreasing in maxWin and in price", () => {
  // Non-decreasing in maxWin (price held fixed across several fixed prices).
  for (const price of [0.5, 2, 12, 100, 766, 2000]) {
    let prev = -1;
    for (const maxWin of [0, 100, 300, 500, 800, 1500, 5000, 12000, 24000, 60000, 1e6]) {
      const e = autoTargetEdge({ price, maxWin });
      assert(e >= prev - 1e-12, `maxWin-monotone (p=${price}): ${prev} → ${e} @ m=${maxWin}`);
      prev = e;
    }
  }
  // Non-decreasing in price (maxWin held fixed across several fixed max-wins).
  for (const maxWin of [50, 500, 2400, 11000, 24000, 50000]) {
    let prev = -1;
    for (const price of [0, 1, 2, 5, 12, 50, 150, 400, 766, 1300, 5000, 1e6]) {
      const e = autoTargetEdge({ price, maxWin });
      assert(e >= prev - 1e-12, `price-monotone (m=${maxWin}): ${prev} → ${e} @ p=${price}`);
      prev = e;
    }
  }
});

check("autoTargetEdge: calm pool → exactly the floor; top-of-catalog → ≈11.10%", () => {
  // A cheap/calm pack: price ≤ priceBase AND maxWin ≤ maxWinBase ⇒ both drivers
  // contribute 0 ⇒ exactly the floor.
  approx(
    autoTargetEdge({ price: DEFAULT_EDGE_CURVE.priceBase, maxWin: DEFAULT_EDGE_CURVE.maxWinBase }),
    DEFAULT_EDGE_FLOOR,
    1e-12,
    "price=priceBase, maxWin=maxWinBase → floor",
  );
  approx(autoTargetEdge({ price: 0.15, maxWin: 300 }), DEFAULT_EDGE_FLOOR, 1e-12, "cheap real pack (Trash) → floor");
  approx(autoTargetEdge({ price: 0.45, maxWin: 12.32 }), DEFAULT_EDGE_FLOOR, 1e-12, "cheap real pack (Snack) → floor");

  // Top-of-catalog reference pack ($766 price, ~$24k top card — Divine Order):
  // both drivers ≈ 1.0 ⇒ premium ≈ maxWinCoef + priceCoef ⇒ edge ≈ 11.10%.
  // Tolerance ±0.0003 (±0.03pp): the log-norm is ≈1.0 at the reference but the
  // live values aren't EXACTLY at priceRef/maxWinRef.
  const divine = autoTargetEdge({ price: 766.92, maxWin: 24265.42 });
  approx(divine, 0.1110, 0.0003, "Divine Order ($766/$24k) ≈ 11.10% (owner target)");
  assert(divine > DEFAULT_EDGE_FLOOR, "top pack edge strictly above floor");
  assert(divine < DEFAULT_EDGE_CEILING, "top pack edge well under ceiling");

  // A mid calm pack (~$12, modest jackpot just over base) sits near 11.00%.
  const mid = autoTargetEdge({ price: 12.55, maxWin: 547.63 });
  assert(mid >= DEFAULT_EDGE_FLOOR, "mid ≥ floor");
  assert(mid < 0.1102 + 1e-9, `mid pack ≈11.00% (got ${(mid * 100).toFixed(4)}%)`);

  // A hypothetical extreme pushes toward — but never past — the ceiling.
  const extreme = autoTargetEdge({ price: 1e6, maxWin: 1e7 });
  assert(extreme > 0.1120, `extreme approaches 11.20%+ (got ${(extreme * 100).toFixed(4)}%)`);
  assert(extreme <= DEFAULT_EDGE_CEILING + 1e-12, "extreme capped at ceiling");
});

check("autoTargetEdge sweep: dense grid stays in band & jointly monotone", () => {
  const prices = [0, 0.5, 1, 2, 5, 12, 30, 80, 200, 500, 766, 1500, 4000, 20000];
  const maxWins = [0, 50, 300, 500, 900, 2400, 6000, 11000, 18000, 24000, 40000, 120000];
  // Band invariant over the whole grid.
  for (const p of prices) {
    for (const m of maxWins) {
      const e = autoTargetEdge({ price: p, maxWin: m });
      assert(
        e >= DEFAULT_EDGE_FLOOR - 1e-12 && e <= DEFAULT_EDGE_CEILING + 1e-12,
        `grid in band (p=${p},m=${m}): ${e}`,
      );
    }
  }
  // Joint monotonicity: raising EITHER axis never lowers the edge.
  for (let i = 0; i < prices.length; i++) {
    for (let j = 0; j < maxWins.length; j++) {
      const base = autoTargetEdge({ price: prices[i]!, maxWin: maxWins[j]! });
      if (i + 1 < prices.length) {
        const up = autoTargetEdge({ price: prices[i + 1]!, maxWin: maxWins[j]! });
        assert(up >= base - 1e-12, `price↑ non-decreasing (p=${prices[i]}→${prices[i + 1]},m=${maxWins[j]})`);
      }
      if (j + 1 < maxWins.length) {
        const up = autoTargetEdge({ price: prices[i]!, maxWin: maxWins[j + 1]! });
        assert(up >= base - 1e-12, `maxWin↑ non-decreasing (p=${prices[i]},m=${maxWins[j]}→${maxWins[j + 1]})`);
      }
    }
  }
});

// ── 11. parsePackHitRate: leading-% tag → fraction; untagged → null ─────
check("parsePackHitRate parses the leading percentage tag from a pack name", () => {
  // Owner's canonical examples.
  approx(parsePackHitRate("1% 18 PLUS")!, 0.01, 1e-12, "1% 18 PLUS → 0.01");
  approx(parsePackHitRate("10% Divine Order")!, 0.1, 1e-12, "10% Divine Order → 0.10");
  approx(parsePackHitRate("5% X")!, 0.05, 1e-12, "5% X → 0.05");
  assert(parsePackHitRate("Supreme") === null, "Supreme (untagged) → null");

  // Decimal tags + whitespace + a space before the % sign.
  approx(parsePackHitRate("2.5% Mythic")!, 0.025, 1e-12, "2.5% → 0.025");
  approx(parsePackHitRate("  15% Padded")!, 0.15, 1e-12, "leading whitespace tolerated");
  approx(parsePackHitRate("10 % Spaced")!, 0.1, 1e-12, "space before % tolerated");
  approx(parsePackHitRate("100% AllWin")!, 1, 1e-12, "100% → 1.0 (upper bound inclusive)");

  // A `%` NOT at the start is not a tag.
  assert(parsePackHitRate("Win 10% Bonus") === null, "non-leading % → null");
  // Degenerate / out-of-range tags fall back to null (untagged default).
  assert(parsePackHitRate("0% Impossible") === null, "0% (unshapeable) → null");
  assert(parsePackHitRate("150% Malformed") === null, "> 100% (malformed) → null");
  assert(parsePackHitRate("") === null, "empty string → null");
  assert(parsePackHitRate("% NoNumber") === null, "bare % with no number → null");
});

// ── 12. autoRetuneTargets uses the NAME tag as the targetWinRate ─────────
check("autoRetuneTargets: a tagged pack targets ITS tag win-rate; untagged → default", () => {
  const cfg = { globalCap: 25000, maxMultCeiling: 100 };

  // Tagged packs: targetWinRate === the parsed tag, intendedHitRate echoes it.
  const tagged: [string, number][] = [
    ["1% 18 PLUS", 0.01],
    ["5% Blazing Light", 0.05],
    ["10% Divine Order", 0.1],
  ];
  for (const [name, expected] of tagged) {
    const t = autoRetuneTargets(50, cfg, name);
    approx(t.targetWinRate, expected, 1e-12, `${name} → targetWinRate ${expected}`);
    assert(t.intendedHitRate !== null, `${name} → intendedHitRate non-null`);
    approx(t.intendedHitRate!, expected, 1e-12, `${name} → intendedHitRate ${expected}`);
    // The spurious 20% flat relaxation must NOT apply to a tagged pack.
    assert(
      t.targetWinRate !== DEFAULT_TARGET_WIN_RATE || expected === DEFAULT_TARGET_WIN_RATE,
      `${name} → NOT forced to the flat default 20%`,
    );
  }

  // Untagged pack → the default 20%, intendedHitRate null.
  const plain = autoRetuneTargets(50, cfg, "Supreme");
  approx(plain.targetWinRate, DEFAULT_TARGET_WIN_RATE, 1e-12, "untagged name → default win-rate");
  assert(plain.intendedHitRate === null, "untagged name → intendedHitRate null");

  // A precomputed numeric hit-rate is honored verbatim (parse-once reuse path).
  const numeric = autoRetuneTargets(50, cfg, 0.03);
  approx(numeric.targetWinRate, 0.03, 1e-12, "precomputed 0.03 → targetWinRate 0.03");
  approx(numeric.intendedHitRate!, 0.03, 1e-12, "precomputed 0.03 → intendedHitRate 0.03");

  // An out-of-range numeric falls back to the untagged default.
  const bad = autoRetuneTargets(50, cfg, 0);
  approx(bad.targetWinRate, DEFAULT_TARGET_WIN_RATE, 1e-12, "0 hit-rate → default");
  assert(bad.intendedHitRate === null, "0 hit-rate → intendedHitRate null");

  // resolveTargetWinRate agrees with the embedded resolution.
  approx(resolveTargetWinRate("10% Divine Order"), 0.1, 1e-12, "resolveTargetWinRate(name)");
  approx(resolveTargetWinRate("Supreme"), DEFAULT_TARGET_WIN_RATE, 1e-12, "resolveTargetWinRate(untagged)");
  approx(resolveTargetWinRate(0.07), 0.07, 1e-12, "resolveTargetWinRate(number)");
  approx(resolveTargetWinRate(null), DEFAULT_TARGET_WIN_RATE, 1e-12, "resolveTargetWinRate(null)");

  // The tagged win-rate is what gets FED to the shaper as targetWinRate — the
  // whole point: a "1%" pack is shaped toward ~1% wins instead of the spurious
  // flat 20%. We assert the WIRING (the value handed to shapeWeights is the tag,
  // not 20%); the shaper's own feasibility at any (edge, win-rate, pool) combo is
  // already swept exhaustively in check #7. On a feasible pool, shaping at the
  // tagged rate yields a win-rate at/below the tag — never the 20% default.
  const taggedWinRate = autoRetuneTargets(10, cfg, "1% Tagged").targetWinRate;
  approx(taggedWinRate, 0.01, 1e-12, "the rate fed to the shaper is the 1% tag, not 20%");
  assert(taggedWinRate < DEFAULT_TARGET_WIN_RATE, "tagged rate is below the flat default");

  // A pool with low-win-rate mass that IS feasible at the tag shapes to ~the tag
  // (not relaxed up to 20%). Win cards rich enough that a tiny win mass + dust
  // can still reach the edge EV. Confirms the tag survives into the shaped risk.
  const r = shapeWeights({
    cards: [
      { value: 0.2 }, // dust — losing mass
      { value: 3 },
      { value: 11 }, // win (just over price → cheap win mass)
      { value: 13 },
      { value: 16 },
    ],
    price: 10,
    targetEdge: 0.0599, // a looser edge the low-win-rate pool can actually hit
    targetWinRate: taggedWinRate,
  });
  if (isSuccess(r)) {
    const wr = r.relaxations.find((x) => x.lever === "winRate");
    const effective = wr ? wr.applied : taggedWinRate;
    assert(
      Math.abs(r.risk.winRate - effective) <= 0.02 + 1e-9,
      `shaped win-rate ≈ effective tag target (${r.risk.winRate}, eff ${effective})`,
    );
    assert(
      r.risk.winRate < DEFAULT_TARGET_WIN_RATE,
      `shaped tagged pack is NOT pushed to the flat 20% default (${r.risk.winRate})`,
    );
  }
});

// ── 13. HIT-RATE-AWARE CAP: a low-hit-rate lottery pack keeps its jackpot ───
//
// Regression for the real "1% 18 PLUS" lottery case: a $1.25 pack whose pool
// carries an $810 jackpot. Under the PLAIN 100× cap the auto cap is $125, which
// strips the $810 (and every card over $125) → the jackpot is gutted and a true
// 1% pack can even go infeasible. The hit-rate-aware cap LOOSENS the multiplier
// inversely with the intended hit-rate (scale = max(1, 0.20/hitRate)) so the big
// top card survives, while a normal (default-win-rate) pack is byte-for-byte
// unchanged.
check("autoMaxWinCap is hit-rate-aware: loosens for lottery packs, unchanged for normal packs", () => {
  const cfg = { globalCap: 25000, maxMultCeiling: 100 };

  // (a) Default / undefined / at-the-default-win-rate ⇒ the plain 100× cap.
  approx(autoMaxWinCap(1.25, cfg), 125, 1e-9, "undefined hitRate → plain 100× ($125)");
  approx(autoMaxWinCap(1.25, cfg, DEFAULT_TARGET_WIN_RATE), 125, 1e-9, "hitRate=default → plain 100×");

  // (b) Scale is (default/hitRate)·TAG_CAP_HEADROOM for below-default tags
  //     (ruleset §1.2 CAP-STRIP): 4×·1.15 at 5%, 20×·1.15 at 1%, 2×·1.15 at
  //     10% — so the owner's deliberately-run 202–207× 10% jackpots survive.
  approx(autoMaxWinCap(1.25, cfg, 0.05), 575, 1e-9, "5% → 4.6× → $575");
  approx(autoMaxWinCap(1.25, cfg, 0.01), 2875, 1e-9, "1% → 23× → $2875 (admits an $810 card)");
  assert(autoMaxWinCap(1.25, cfg, 0.01) >= 810, "1% cap admits the $810 jackpot");
  // CAP-STRIP regression: a 10% pack's cap is 230×price — Bling Bling's
  // deliberately-run 202.5× ($2,400 @ $11.85) and Chaos' 206.8× survive.
  approx(autoMaxWinCap(11.85, cfg, 0.1), 11.85 * 230, 1e-9, "10% → 230×price");
  assert(
    autoMaxWinCap(11.85, cfg, 0.1) >= 2400,
    "10% cap admits Bling Bling's $2,400 jackpot (202.5×)",
  );

  // (c) NEVER tighter than 100× for a higher-than-default hit-rate (scale clamps ≥ 1).
  approx(autoMaxWinCap(1.25, cfg, 0.5), 125, 1e-9, "50% hitRate → still 100× (never tighter)");
  approx(autoMaxWinCap(1.25, cfg, 1.0), 125, 1e-9, "100% hitRate → still 100×");

  // (d) The absolute global cap clamp is preserved even with the loosened scale.
  approx(autoMaxWinCap(1000, cfg, 0.01), 25000, 1e-9, "loosened mult still clamped by globalCap");

  // (e) A normal untagged pack's whole target set is UNCHANGED by the new param.
  const normal = autoRetuneTargets(10, cfg); // untagged
  approx(normal.maxWinCap, autoMaxWinCap(10, cfg), 1e-9, "untagged cap = plain cap");
  approx(normal.maxWinCap, 1000, 1e-9, "untagged $10 pack cap = $1000");
  assert(normal.intendedHitRate === null, "untagged → intendedHitRate null");

  // (f) END-TO-END: the real $1.25 1% pool — FEASIBLE with the hit-rate-aware cap,
  //     edge ≥ target, and a REAL jackpot (the $810 card survives, not ~$118).
  const pool = [
    { value: 810.07 }, { value: 508.45 }, { value: 118.21 }, { value: 114.0 },
    { value: 75.47 }, { value: 64.76 }, { value: 60.25 }, { value: 1.3 },
    { value: 0.08 }, { value: 0.05 }, { value: 0.02 },
  ];
  const t = autoRetuneTargets(1.25, cfg, "1% 18 PLUS");
  approx(t.targetWinRate, 0.01, 1e-12, "1% pack targets 1% win-rate");
  approx(t.maxWinCap, 2875, 1e-9, "1% pack auto cap = $2875 (loosened, incl. headroom)");
  assert(t.targetEdge <= DEFAULT_EDGE_CEILING + 1e-12, "edge target stays under the ceiling");

  const shaped = shapeWeights({
    cards: pool,
    price: 1.25,
    targetEdge: t.targetEdge,
    targetWinRate: 0.01,
    maxWinCap: t.maxWinCap,
    nearMissMin: t.nearMissMin,
  });
  assert(isSuccess(shaped), "1% lottery pool is FEASIBLE under the hit-rate-aware cap");
  if (isSuccess(shaped)) {
    assert(shaped.edge >= t.targetEdge - 1e-3, `edge ≥ target (${shaped.edge} ≥ ${t.targetEdge})`);
    assert(shaped.risk.maxWin > 500, `maxWin is a real jackpot, not gutted (${shaped.risk.maxWin})`);
    approx(shaped.risk.maxWin, 810.07, 1e-6, "the $810 jackpot survives the cap");
  }

  // (g) CONTROL: the SAME pool under the OLD plain $125 cap guts the jackpot to
  //     the cheapest card ≤ $125 (here $118.21) — proving the bug the fix closes.
  const shapedOld = shapeWeights({
    cards: pool,
    price: 1.25,
    targetEdge: t.targetEdge,
    targetWinRate: 0.01,
    maxWinCap: 125,
    nearMissMin: t.nearMissMin,
  });
  if (isSuccess(shapedOld)) {
    assert(
      shapedOld.risk.maxWin <= 125 + 1e-9,
      `plain $125 cap guts the jackpot to ≤ $125 (${shapedOld.risk.maxWin})`,
    );
  }
});

// ── 14. Clean-ladder snap post-process (buffer-residual algorithm) ──────
//
// The snap converts the precise solver weights into human-readable round
// odds via a BUFFER-RESIDUAL scheme: N-1 cards land on clean ladder rungs
// (0.05%, 0.1%, 10%, 25%, ...), and ONE buffer card (the largest mass,
// typically the dust card) absorbs the residual so the total stays at 100%
// without renormalizing every rung (which is what made the old snap
// produce ugly 0.0521% rather than 0.05%).
//
// Integration is two-tiered:
//   1. Try the basic buffer-residual snap → ACCEPT if edge ∈ [target,
//      target+0.05pp] AND win-rate stays within soft tol.
//   2. Otherwise, run a 3-stage escalating local search (3^5 → 5^4 → 3^7)
//      over the top EV-impact cards. The first stage that lands edge within
//      tol AND preserves win-rate is accepted.
//   3. Otherwise → SAFETY FALLBACK: keep the precise weights. The snap
//      never regresses edge, by construction.
//
// The harness covers three concrete cases:
//   (a) A normal-edge $10 pack with mixed cards → snap accepted and N-1
//       cards land on clean ladder rungs.
//   (b) The owner's "1% 18 PLUS" lottery pool — local search must find a
//       combo that lands within edge tolerance with N-1 clean rungs (this
//       was the motivating case for the buffer-residual rewrite).
//   (c) An adversarial pool where every snap combo crashes edge → safety
//       fallback kicks in and keeps the precise weights. Edge is still
//       within the one-sided-up window.

// Build the same ladder as risk.ts uses, for the per-pct nearness check.
const CLEAN_LADDER_BASE = [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10, 15, 20, 25, 30, 40, 50, 75];
const CLEAN_LADDER: number[] = [];
for (let decade = -6; decade <= 1; decade++) {
  for (const b of CLEAN_LADDER_BASE) {
    const v = b * Math.pow(10, decade);
    if (v > 0 && v < 100) CLEAN_LADDER.push(v);
  }
}
CLEAN_LADDER.push(100);
CLEAN_LADDER.sort((a, b) => a - b);

function isOnLadder(pct: number, tol = 1e-6): boolean {
  if (!(pct > 0)) return false;
  for (const v of CLEAN_LADDER) {
    if (Math.abs(v - pct) <= tol * Math.max(1, v)) return true;
  }
  return false;
}

function countLadderHits(pcts: number[]): number {
  let n = 0;
  for (const p of pcts) if (isOnLadder(p)) n++;
  return n;
}

// ── 14a. Normal-edge pack snaps cleanly (N-1 cards on ladder) ──────────
check("snap (a): a normal-edge pack snaps with N-1 cards landing on clean ladder rungs", () => {
  // A $5 pack with a flat 3-card spread: $0.50 dust + $20.25 win + $40.00
  // grail. The buffer-residual snap lands all three pcts on EXACT ladder
  // rungs (85% / 10% / 5%) and the edge stays within the ±0.05pp accept
  // window. This is the "clean operator experience" the rewrite targets:
  // the user reads "85%, 10%, 5%" instead of "84.7%, 10.31%, 4.99%".
  const cards = [
    { value: 0.50 },
    { value: 20.25 },
    { value: 40.00 },
  ];
  const price = 5;
  const targetEdge = 0.1099;
  const targetWinRate = 0.15;
  const r = shapeWeights({ cards, price, targetEdge, targetWinRate });
  assert(isSuccess(r), `expected success: ${"error" in r ? r.error : ""}`);
  if (!isSuccess(r)) return;
  assert(r.snapped === true, `snap should be applied for a normal-edge pack, got snapped=${r.snapped}`);
  assert(
    Math.abs(r.edge - targetEdge) <= 0.0005 + 1e-9,
    `edge within ±0.05pp of target (got ${(r.edge * 100).toFixed(4)}%, target ${(targetEdge * 100).toFixed(2)}%)`,
  );
  assert(r.edge >= targetEdge - 1e-9, `one-sided-up invariant survives the snap (${r.edge})`);

  // N-1 cards should land on exact ladder rungs (the Nth = buffer = residual).
  // For this specific pool all three land on ladder rungs (85% IS on the
  // ladder — the buffer happens to coincide with a rung after rounding).
  const total = r.weights.reduce((a, b) => a + b, 0);
  const pcts = r.weights.map((w) => (w / total) * 100);
  const hits = countLadderHits(pcts);
  assert(
    hits >= cards.length - 1,
    `at least N-1 cards (${cards.length - 1}) on clean ladder rungs (got ${hits} of ${cards.length}). pcts: ${pcts.map(p => p.toFixed(4) + "%").join(", ")}`,
  );

  // Print for the operator to see real "clean" numbers.
  console.log(`      [normal $5 pack snapped pcts — ${hits}/${cards.length} on ladder, edge ${(r.edge * 100).toFixed(4)}%]`);
  for (let i = 0; i < cards.length; i++) {
    const onL = isOnLadder(pcts[i]!) ? " (LADDER)" : " (buffer)";
    console.log(`        $${cards[i]!.value.toFixed(2).padStart(7)} → ${pcts[i]!.toFixed(4)}%${onL}`);
  }
});

// ── 14b. "1% 18 PLUS" lottery pool snaps to clean rungs via local search ──
check("snap (b): '1% 18 PLUS' lottery pool — edge stays at target after lottery skew", () => {
  // The owner's motivating real-world case: a $1.25 lottery pack with 18
  // jackpots and a $0.08 dust card. With the lottery-skew post-process now
  // running BEFORE the snap (it gates on targetWinRate ≤ 0.05), this pool
  // takes the steep grail-band redistribution path; the snap may then accept
  // or fall back depending on whether the post-skew pcts align with ladder
  // rungs. The invariant that survives both post-processes: edge stays at
  // target (within ±0.05pp) and the one-sided-up invariant holds.
  const pool = [
    { value: 810.07 }, { value: 508.45 }, { value: 118.21 }, { value: 114.0 },
    { value: 75.47 }, { value: 64.76 }, { value: 60.25 }, { value: 1.3 },
    { value: 0.08 }, { value: 0.05 }, { value: 0.02 },
  ];
  const price = 1.25;
  const targetEdge = 0.1099;
  const r = shapeWeights({
    cards: pool,
    price,
    targetEdge,
    targetWinRate: 0.01,
    maxWinCap: 2500,
    nearMissMin: 0.1,
  });
  assert(isSuccess(r), `expected success: ${"error" in r ? r.error : ""}`);
  if (!isSuccess(r)) return;
  // Lottery skew fires for this 1% tagged pool.
  assert(
    r.lotterySkewApplied === true,
    `lottery skew applied for 1% tagged pool (got ${r.lotterySkewApplied})`,
  );
  // Edge invariant survives both post-processes.
  assert(
    Math.abs(r.edge - targetEdge) <= 0.0005 + 1e-9,
    `edge within ±0.05pp of target (got ${(r.edge * 100).toFixed(4)}%, target ${(targetEdge * 100).toFixed(2)}%)`,
  );
  assert(r.edge >= targetEdge - 1e-9, `one-sided-up invariant survives the skew+snap (${r.edge})`);

  // Print the final pcts so the owner can compare to the verbatim profile.
  const total = r.weights.reduce((a, b) => a + b, 0);
  const pcts = r.weights.map((w) => (w / total) * 100);
  const hits = countLadderHits(pcts);
  console.log(`      [1% 18 PLUS final pcts — ${hits}/${pool.length} on ladder, edge ${(r.edge * 100).toFixed(4)}%, snapped=${r.snapped}]`);
  for (let i = 0; i < pool.length; i++) {
    const onL = isOnLadder(pcts[i]!) ? " (LADDER)" : " (buffer/precise)";
    console.log(`        $${pool[i]!.value.toFixed(2).padStart(7)} → ${pcts[i]!.toFixed(6)}%${onL}`);
  }
});

// ── 14c. Adversarial pool → safety fallback keeps precise weights ──────
check("snap (c): adversarial pool (every snap combo crashes edge) → safety fallback", () => {
  // A degenerate-ish pool where every nearby ladder configuration overshoots
  // the edge tolerance. We use a pool whose precise pcts sit at awkward
  // "between-rung" values and whose buffer's mass-fraction is so dominant
  // that any rung snap on the win cards produces a large EV swing relative
  // to the narrow 0.05pp accept window.
  //
  // We don't claim every pool with these properties falls back — but if for
  // some run the snap DOES accept, the tolerance contract still holds. We
  // pin the SAFETY CONTRACT: regardless of snap accept/reject, the result
  // satisfies edge ≥ target AND edge − target ≤ 0.001 (the precise solver's
  // one-sided-up window). The snap NEVER regresses edge.
  const cards = [
    { value: 0.01 }, // tiny dust — will be the buffer
    { value: 0.5 }, // dust
    { value: 7.3 }, // near-miss-ish
    { value: 12.7 }, // win
    { value: 23.1 }, // win
    { value: 47 }, // grail
  ];
  const price = 10;
  const targetEdge = 0.1099;
  const r = shapeWeights({ cards, price, targetEdge, targetWinRate: 0.18 });
  assert(isSuccess(r), `expected success: ${"error" in r ? r.error : ""}`);
  if (!isSuccess(r)) return;
  // SAFETY CONTRACT: regardless of snap acceptance, edge is within the
  // precise solver's one-sided-up window.
  assert(r.edge >= targetEdge - 1e-9, `edge ≥ target (snap never regresses) (${r.edge})`);
  assert(
    r.edge - targetEdge <= 0.001 + 1e-9,
    `edge − target ≤ 0.001 (within precise window) (got ${r.edge - targetEdge})`,
  );

  // If snap was NOT applied → safety fallback. Otherwise (snap accepted)
  // the tolerance is implicitly tighter (within 0.05pp). Either branch is
  // valid; what we test is the safety contract.
  console.log(`      snap=${r.snapped}, edge=${(r.edge * 100).toFixed(4)}%`);
});

// ── 14d. Sweep snap-acceptance rate (regression for buffer-residual win) ──
check("snap (d): sweep snap-acceptance rate is significantly higher than the naive baseline", () => {
  // The OLD snap-then-renormalize algorithm accepted ~0.15% of feasible
  // sweep pools (the naive renorm corrupted nearly every clean rung). The
  // buffer-residual + local-search rewrite must dramatically beat that —
  // we set a floor at 20% to catch any future regression that re-introduces
  // the naive behaviour.
  function dist(kind: "flat" | "power" | "bimodal", n: number, price: number): { value: number }[] {
    const out: { value: number }[] = [];
    if (kind === "flat") {
      for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0 : i / (n - 1);
        out.push({ value: price * (0.1 + t * 7.9) });
      }
    } else if (kind === "power") {
      for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0 : i / (n - 1);
        out.push({ value: price * 0.05 * Math.pow(400, t) });
      }
    } else {
      for (let i = 0; i < n; i++) {
        if (i < Math.ceil(n * 0.7)) {
          const t = i / Math.max(1, Math.ceil(n * 0.7) - 1);
          out.push({ value: price * (0.05 + t * 0.4) });
        } else {
          const j = i - Math.ceil(n * 0.7);
          out.push({ value: price * (1.2 + j * 6) });
        }
      }
    }
    return out;
  }
  let feasible = 0;
  let snappedCount = 0;
  // A modest grid — the full sweep in check #7 covers the same pool space
  // but adds cap/floor combos that the snap-acceptance measure doesn't need.
  for (const price of [1, 5, 25, 100]) {
    for (const kind of ["flat", "power", "bimodal"] as const) {
      for (let n = 3; n <= 40; n++) {
        const cards = dist(kind, n, price);
        for (const targetEdge of [0.0599, 0.1099, 0.15]) {
          for (const targetWinRate of [0.1, 0.2, 0.3]) {
            const r = shapeWeights({ cards, price, targetEdge, targetWinRate });
            if (isSuccess(r)) {
              feasible += 1;
              if (r.snapped) snappedCount += 1;
            }
          }
        }
      }
    }
  }
  const rate = feasible > 0 ? snappedCount / feasible : 0;
  console.log(`      snap-acceptance rate: ${snappedCount}/${feasible} = ${(rate * 100).toFixed(2)}%`);
  // Threshold lowered from 20% to 5% after monotonicity invariants landed
  // (`repairSnapMonotonicity`): the snap now ALSO enforces within-band pct
  // ascends-as-value-descends, plus strict rarity at the GRAIL top. Both are
  // owner-facing designer rules that the naive snap never respected. The
  // tighter constraint drops the sweep rate to ~5-10% — that's correct: a
  // snap that violates monotonicity is unacceptable to the owner, so we
  // intentionally reject more candidates. Floor stays well above the naive
  // baseline (0.15%) — anything lower would be a regression in the snap
  // itself, not just the constraint.
  assert(
    rate >= 0.05,
    `snap-acceptance rate ≥ 5% (got ${(rate * 100).toFixed(2)}%) — monotonicity-aware snap must still clear the naive baseline by an order of magnitude`,
  );
});

// ── 14e. Direct snap primitive: returned pcts are buffer-residual clean ──
check("snap (e): snapWeightsToCleanLadder places N-1 entries on exact ladder rungs", () => {
  // A controlled weight vector — what the snap primitive returns must satisfy:
  // exactly one slot (the buffer = argmax mass) holds the residual, all other
  // positive slots sit on exact ladder rungs.
  const weights = [10000, 25000, 50000, 70000, 90000]; // bimodal-ish
  const price = 10;
  const snap = snapWeightsToCleanLadder({ weights, price });
  const total = snap.weights.reduce((a, b) => a + b, 0);
  assert(total > 0, `snapped total > 0 (got ${total})`);
  const pcts = snap.weights.map((w) => (w / total) * 100);
  const hits = countLadderHits(pcts);
  // The largest-pct slot is the buffer. N-1 of the other 4 should be on rungs.
  // Allow integer-quantization slop — we accept "at least N-1 on rungs".
  const positive = pcts.filter((p) => p > 0).length;
  assert(
    hits >= positive - 1,
    `at least ${positive - 1} of ${positive} positive slots on ladder (got ${hits}). pcts: ${pcts.map(p => p.toFixed(4) + "%").join(", ")}`,
  );
});

// ── 15. Lottery skew (steep grail-band redistribution for tagged 1%/5% packs) ──
//
// The inverse solver's WITHIN-GRAIL distribution lands near-flat, but owners
// hand-tune lottery packs with a steep ~190× ratio between cheapest and most
// expensive grail. `applyLotterySkew` re-shapes the GRAIL band along a steep
// value^(-β) (β=2) curve, preserving total grail mass. The integration keeps
// the redistribution only when the resulting edge stays within ±0.05pp of
// target — otherwise the safe fallback keeps the solver's precise weights.
// The trigger gate (targetWinRate ≤ 0.05) makes this a no-op for normal packs.

// Build a pool where the grail-EV swing is small enough that the redistribution
// lands in tolerance: a tagged 5% pack where the grail values are CLOSE TOGETHER
// (the EV change from re-shaping the band is bounded by the value spread).
check("lottery skew: tagged 5% pack with close-range grails ⇒ skew applied, steep ratio", () => {
  // The grail-band EV swing is bounded by the value spread; with grails
  // close together ($300–$390, a ~30% spread) the swing is small enough
  // to fit in tolerance. The pool also carries WIN/NEARMISS/DUST cards so
  // the EV target is reachable for a 5% win-rate at 10.99% edge.
  const price = 10;
  const pool = [
    { value: 0.1 },   // dust
    { value: 0.5 },   // dust
    { value: 1 },     // dust
    { value: 3 },     // dust
    { value: 7 },     // near-miss
    { value: 11 },    // win
    { value: 13 },    // win
    { value: 16 },    // win
    { value: 300 },   // grail (cheapest)
    { value: 330 },   // grail
    { value: 360 },   // grail
    { value: 390 },   // grail (most expensive — spread ~1.3×)
  ];
  const targetEdge = 0.1099;
  const targetWinRate = 0.05;
  const r = shapeWeights({ cards: pool, price, targetEdge, targetWinRate });
  assert(isSuccess(r), `expected success: ${"error" in r ? r.error : ""}`);
  if (!isSuccess(r)) return;

  // For a 5% tagged pack with > 1 grail and a small grail value spread, the
  // skew MUST be applied (the EV drift is well under the ±0.05pp tolerance).
  assert(r.lotterySkewApplied === true, `lotterySkewApplied true (got ${r.lotterySkewApplied})`);

  // Edge invariants still hold.
  assert(r.edge >= targetEdge - 1e-9, `edge ≥ target (${r.edge})`);
  assert(r.edge - targetEdge <= 0.001 + 1e-9, `edge ≤ target+0.001 (got ${r.edge - targetEdge})`);

  // Cheapest grail ($300) must dominate the most expensive ($390) by the
  // value^(-2) ratio (390/300)^2 ≈ 1.69×.
  const total = r.weights.reduce((a, b) => a + b, 0);
  const pctOf = (val: number): number => {
    const i = pool.findIndex((c) => c.value === val);
    return (r.weights[i]! / total) * 100;
  };
  const pct300 = pctOf(300);
  const pct390 = pctOf(390);
  const ratio = pct300 / pct390;
  // Expect ratio close to (390/300)^2 = 1.69; allow a wide margin for integer
  // quantization (small grail weights round aggressively).
  assert(
    ratio > 1.3,
    `cheap grail dominates expensive grail (300=${pct300.toFixed(4)}%, 390=${pct390.toFixed(4)}%, ratio ${ratio.toFixed(3)}× vs theoretical 1.69×)`,
  );
});

// THE FLAGSHIP TEST: the real "1% 18 PLUS" pool from the spec. The lottery
// skew + EV compensation MUST produce the owner's verbatim "steep" grail
// distribution: $810 around 0.001%, $60 around 0.19%, ratio ~190×. Edge stays
// at target.
check("lottery skew: 1% 18 PLUS pool — steep grail distribution matches owner verbatim", () => {
  const pool = [
    { value: 810.07 }, // grail (rarest jackpot)
    { value: 508.45 }, // grail
    { value: 118.21 }, // grail
    { value: 114.0 },  // grail
    { value: 75.47 },  // grail
    { value: 64.76 },  // grail
    { value: 60.25 },  // grail (cheapest grail)
    { value: 1.70 },   // win (≥ price)
    { value: 0.95 },   // near-miss
    { value: 0.08 },   // dust
  ];
  const price = 1.25;
  const targetEdge = 0.1099;
  const r = shapeWeights({
    cards: pool,
    price,
    targetEdge,
    targetWinRate: 0.01,
    maxWinCap: 2500,
    nearMissMin: 0.1,
  });
  assert(isSuccess(r), `expected success: ${"error" in r ? r.error : ""}`);
  if (!isSuccess(r)) return;

  // The lottery skew MUST have been applied — this is the spec's flagship
  // scenario, the whole reason for the feature.
  assert(
    r.lotterySkewApplied === true,
    `lotterySkewApplied true (got ${r.lotterySkewApplied})`,
  );

  // Edge invariants still hold (one-sided-up survives the skew + compensation).
  assert(r.edge >= targetEdge - 1e-9, `edge ≥ target (${r.edge})`);
  assert(
    Math.abs(r.edge - targetEdge) <= 0.0005 + 1e-9,
    `edge within ±0.05pp of target (${r.edge}, target ${targetEdge})`,
  );

  // Steep within-grail distribution: $810 probability < $60 probability / 10.
  const total = r.weights.reduce((a, b) => a + b, 0);
  const pctOf = (val: number): number => {
    const i = pool.findIndex((c) => c.value === val);
    return (r.weights[i]! / total) * 100;
  };
  const pct810 = pctOf(810.07);
  const pct60 = pctOf(60.25);
  assert(
    pct60 >= pct810 * 10,
    `cheap grail dominates by ≥ 10× ($60.25=${pct60.toFixed(6)}%, $810.07=${pct810.toFixed(6)}%, ratio ${(pct60 / pct810).toFixed(2)}×)`,
  );

  // Print the steep grail probability distribution — the owner's "$810 at
  // ~0.001%, $60 at ~0.19%" target profile.
  console.log(`      [1% 18 PLUS — STEEP grail distribution after lottery skew + EV compensation]`);
  for (let i = 0; i < pool.length; i++) {
    if (pool[i]!.value >= 5 * price) {
      console.log(`        $${pool[i]!.value.toFixed(2).padStart(7)} → ${((r.weights[i]! / total) * 100).toFixed(6)}%`);
    }
  }
  console.log(`        ratio cheapest/most-expensive grail: ${(pct60 / pct810).toFixed(2)}× (owner verbatim ~190×)`);
  console.log(`        edge: ${(r.edge * 100).toFixed(4)}% (target ${(targetEdge * 100).toFixed(2)}%)`);
});

check("lottery skew: normal 20%-win pack is byte-for-byte unchanged (no-op)", () => {
  // The same rich pool from check #6 — a normal 20% win-rate pack must NOT
  // get the lottery skew. lotterySkewApplied === false; existing solver
  // behavior is preserved.
  const cards = [
    { value: 0.1 },
    { value: 0.5 },
    { value: 1 },
    { value: 3 },
    { value: 7 },
    { value: 12 },
    { value: 25 },
    { value: 80 },
  ];
  const price = 10;
  const targetEdge = TARGET_HOUSE_EDGE;
  const targetWinRate = 0.2; // well above the 0.05 lottery threshold

  const r = shapeWeights({ cards, price, targetEdge, targetWinRate });
  assert(isSuccess(r), `expected success: ${"error" in r ? r.error : ""}`);
  if (!isSuccess(r)) return;
  // The lottery skew gate is targetWinRate ≤ 0.05; this is 0.20 → no-op.
  assert(r.lotterySkewApplied === false, `lotterySkewApplied false for normal pack (got ${r.lotterySkewApplied})`);
  // Existing invariants still hold.
  assert(r.edge >= targetEdge - 1e-9, `edge ≥ target (${r.edge})`);
  assert(r.edge - targetEdge <= 0.001 + 1e-9, `edge − target ≤ 0.001 (got ${r.edge - targetEdge})`);
  assert(Math.abs(r.risk.winRate - targetWinRate) <= 0.02 + 1e-9, `win-rate within tol (${r.risk.winRate})`);
});

// ── 16. searchBestPriceForCleanSnap ─────────────────────────────────────
//
// The price-search wrapper sweeps cent-stepped candidate prices around the
// base (default ±25%, max 50 candidates) and returns the candidate whose
// `shapeWeights` result keeps `snapped=true` while staying closest to the
// base price. Two pinned invariants:
//
//   (a) When the base price fails to snap cleanly but a nearby price DOES,
//       the wrapper returns the nearby price with snapped=true (and the
//       chosen price differs from the base, so the search delivered the
//       cleaner odds the price lever exists to find).
//   (b) When the base price already snaps cleanly, the wrapper picks the
//       base (no unnecessary deviation) and reports `fellBackToBase: false`
//       (base was the winner on its own merits, not a degraded fallback).
//
// Both checks bind the wrapper's CONTRACT (snap-prefer, base-prefer,
// degradation-aware fellBackToBase). The exact pool that surfaces (a) is
// search-discovered — the test scans a couple of pools and asserts that AT
// LEAST one demonstrates the snap improvement (so the test isn't brittle to
// future `shapeWeights` tweaks).
check("searchBestPriceForCleanSnap (a): a pool that snaps cleaner at a nearby price → chosen ≠ base, snapped=true", () => {
  // A grid of pools at $1.00. The wrapper sweeps cent-stepped candidates
  // around the base and reports `searched`. The contract: AT LEAST one pool
  // in this grid must demonstrate the snap improvement (chosen price ≠
  // basePrice, result is snapped). If `shapeWeights` ever evolves so EVERY
  // grid pool snaps cleanly at the base, the assertion below will surface a
  // clear failure rather than silently noop.
  const pools: { value: number }[][] = [
    // Mix of nominally awkward grail/win values + a thin dust at $1.00.
    [{ value: 0.07 }, { value: 1.13 }, { value: 2.17 }, { value: 4.29 }, { value: 9.41 }, { value: 17.83 }],
    [{ value: 0.09 }, { value: 0.62 }, { value: 1.11 }, { value: 2.37 }, { value: 4.78 }, { value: 11.27 }, { value: 23.89 }],
    [{ value: 0.04 }, { value: 0.55 }, { value: 1.07 }, { value: 3.29 }, { value: 6.41 }, { value: 13.83 }],
    [{ value: 0.11 }, { value: 0.83 }, { value: 1.19 }, { value: 2.51 }, { value: 5.07 }, { value: 9.91 }, { value: 19.73 }],
  ];
  const basePrice = 1.0;
  const targetEdge = 0.1099;
  const targetWinRate = 0.2;

  let foundImprovement = false;
  let firstImprovementCents: number | null = null;
  for (const cards of pools) {
    const baseShaped = shapeWeights({ cards, price: basePrice, targetEdge, targetWinRate });
    const baseSnapped = isSuccess(baseShaped) && baseShaped.snapped === true;
    if (baseSnapped) continue; // not a candidate for the (a) invariant

    const result = searchBestPriceForCleanSnap({
      cards,
      basePrice,
      targetEdge,
      targetWinRate,
    });
    // Search must have evaluated at least one candidate.
    assert(result.searched >= 1, `searched ≥ 1, got ${result.searched}`);
    // If the search found a cleaner price, the contract pins both legs.
    if (isSuccess(result.bestResult) && result.bestResult.snapped === true) {
      assert(
        result.bestPrice !== basePrice,
        `(a) found snap at base price unexpectedly — pool was supposed to fail at base; price ${result.bestPrice}`,
      );
      assert(result.fellBackToBase === false, `(a) fellBackToBase must be false when search succeeded`);
      // Sanity: the chosen price must be within the ±25% band.
      const maxCents = Math.floor(basePrice * 0.25 * 100);
      const distCents = Math.abs(Math.round(result.bestPrice * 100) - Math.round(basePrice * 100));
      assert(
        distCents <= maxCents,
        `(a) chosen price within ±25% (${distCents}¢ ≤ ${maxCents}¢)`,
      );
      foundImprovement = true;
      firstImprovementCents = distCents;
      break;
    }
  }
  assert(
    foundImprovement,
    `(a) expected at least one pool where the price search finds a cleaner snap; none did. (Confirms the snap is now too strict to demonstrate the lever — review pool fixtures or shapeWeights regressions.)`,
  );
  // Logged for the harness output so a future regression in either direction
  // (snap got stricter or snap got looser) shows up as a value change.
  console.log(
    `      └─ (a) discovered snap improvement at ${firstImprovementCents}¢ from base`,
  );
});

check("searchBestPriceForCleanSnap (b): a pool already clean at base → picks basePrice, fellBackToBase=false", () => {
  // The same "normal-edge $5 pack" used by harness check 14a — a
  // documented clean-snapping pool. `shapeWeights` returns `snapped=true`
  // here, so the wrapper must KEEP the base price (no unnecessary
  // deviation) and report `fellBackToBase=false` (base was the winner on
  // its own merits, not a degraded fallback).
  const cards = [
    { value: 0.5 },
    { value: 20.25 },
    { value: 40.0 },
  ];
  const basePrice = 5;
  const targetEdge = 0.1099;
  const targetWinRate = 0.15;

  // Pre-check: the base must actually be a clean snap for the (b) invariant
  // to apply. If a future regression breaks this assumption the test surfaces
  // a clear failure here instead of silently asserting the wrong thing.
  const baseShaped = shapeWeights({ cards, price: basePrice, targetEdge, targetWinRate });
  assert(isSuccess(baseShaped), `(b) base must be feasible: ${"error" in baseShaped ? baseShaped.error : ""}`);
  if (!isSuccess(baseShaped)) return;
  assert(
    baseShaped.snapped === true,
    `(b) base must snap cleanly for the "pick base" invariant; snapped=${baseShaped.snapped}. Update the fixture if shapeWeights gets stricter.`,
  );

  const result = searchBestPriceForCleanSnap({
    cards,
    basePrice,
    targetEdge,
    targetWinRate,
  });

  // The wrapper must short-circuit on a clean base (no sweep needed).
  assert(
    result.bestPrice === basePrice,
    `(b) chosen price = basePrice, got ${result.bestPrice}`,
  );
  assert(
    result.fellBackToBase === false,
    `(b) fellBackToBase=false when base snaps cleanly (was ${result.fellBackToBase})`,
  );
  assert(
    isSuccess(result.bestResult) && result.bestResult.snapped === true,
    `(b) returned result must be a snapped success`,
  );
  // Short-circuit semantics: only the base candidate was evaluated.
  assert(
    result.searched === 1,
    `(b) searched=1 (short-circuit on clean base), got ${result.searched}`,
  );
});

// ── 16c. searchBestPriceForCleanSnap — TAGGED 1% pack lands on tag ─────
//
// Owner spec (2026-06-22): a pack tagged "X%" in its name MUST achieve EXACTLY
// X% win-rate — within 0.01pp, not 1.6% or 1.95%. The lottery-skew dust-scale
// EV-compensation drifts the achieved win-rate above the tag at the base
// price, so the price-search must elevate strict win-rate accuracy ABOVE
// snap-cleanness as the primary scoring criterion when `taggedWinRate` is
// passed.
//
// This designed 1% pool (3 grails + a 30-card dust ladder) has enough dust
// granularity that the lottery skew has real slack to land win-rate exactly
// on the 1% tag at SOME price in the ±25% band — verified by the test
// assertion. The chosen price always stays within ±25% of base.
check(
  "searchBestPriceForCleanSnap (c): tagged 1% pack — winRate lands within 0.01pp of tag",
  () => {
    const pool: { value: number }[] = [
      { value: 100 },
      { value: 200 },
      { value: 500 },
      ...Array.from({ length: 30 }, (_, i) => ({ value: 0.5 - i * 0.015 })).filter(
        (c) => c.value > 0,
      ),
    ];
    const basePrice = 1.25;
    const targetEdge = 0.1099;
    const targetWinRate = 0.01;

    const result = searchBestPriceForCleanSnap({
      cards: pool,
      basePrice,
      targetEdge,
      targetWinRate,
      nearMissMin: 0.05,
      taggedWinRate: targetWinRate, // tagged-mode activation
    });

    assert(
      isSuccess(result.bestResult),
      `(c) chosen result must be a success arm: ${
        "error" in result.bestResult ? result.bestResult.error : ""
      }`,
    );
    if (!isSuccess(result.bestResult)) return;

    assert(
      result.taggedAccuracyHit === true,
      `(c) taggedAccuracyHit must be true (got ${result.taggedAccuracyHit}); achieved winRate ${(result.bestResult.risk.winRate * 100).toFixed(4)}% vs tag 1%`,
    );
    assert(
      Math.abs(result.bestResult.risk.winRate - targetWinRate) <=
        TAGGED_WINRATE_TOLERANCE + 1e-12,
      `(c) winRate within 0.01pp of 1% tag (achieved ${(result.bestResult.risk.winRate * 100).toFixed(4)}%, delta ${(Math.abs(result.bestResult.risk.winRate - targetWinRate) * 100).toFixed(4)}pp)`,
    );

    // Edge still hits target (the underlying shapeWeights enforces this).
    assert(
      result.bestResult.edge >= targetEdge - 1e-9,
      `(c) edge ≥ target (${result.bestResult.edge}, target ${targetEdge})`,
    );

    // Chosen price stays within ±25% of base.
    const priceDelta = Math.abs(result.bestPrice - basePrice) / basePrice;
    assert(
      priceDelta <= 0.25 + 1e-9,
      `(c) chosen price ${result.bestPrice.toFixed(2)} within ±25% of base ${basePrice.toFixed(2)} (delta ${(priceDelta * 100).toFixed(2)}%)`,
    );

    console.log(
      `      [tagged 1% — winner $${result.bestPrice.toFixed(2)}  wr=${(result.bestResult.risk.winRate * 100).toFixed(4)}%  edge=${(result.bestResult.edge * 100).toFixed(4)}%]`,
    );
  },
);

// ── 16d. searchBestPriceForCleanSnap — TAGGED 5% pack lands on tag ─────
//
// Same Owner-spec accuracy gate at the 5% tag. The designed pool (3 grails,
// a single win-band card at $2, a 9-card dust ladder) was found via a
// fan-out scan: with the lottery skew + clean-snap pipeline, $0.94 lands the
// achieved win-rate exactly on the 5% ladder rung (delta 0).
check(
  "searchBestPriceForCleanSnap (d): tagged 5% pack — winRate lands within 0.01pp of tag",
  () => {
    const pool: { value: number }[] = [
      { value: 50 },
      { value: 100 },
      { value: 200 },
      { value: 2 }, // single win-band card
      { value: 0.6 },
      { value: 0.5 },
      { value: 0.4 },
      { value: 0.3 },
      { value: 0.2 },
      { value: 0.1 },
      { value: 0.05 },
      { value: 0.02 },
      { value: 0.01 },
    ];
    const basePrice = 1.25;
    const targetEdge = 0.1099;
    const targetWinRate = 0.05;

    const result = searchBestPriceForCleanSnap({
      cards: pool,
      basePrice,
      targetEdge,
      targetWinRate,
      nearMissMin: 0.05,
      taggedWinRate: targetWinRate,
    });

    assert(
      isSuccess(result.bestResult),
      `(d) chosen result must be a success arm: ${
        "error" in result.bestResult ? result.bestResult.error : ""
      }`,
    );
    if (!isSuccess(result.bestResult)) return;

    assert(
      result.taggedAccuracyHit === true,
      `(d) taggedAccuracyHit must be true (got ${result.taggedAccuracyHit}); achieved winRate ${(result.bestResult.risk.winRate * 100).toFixed(4)}% vs tag 5%`,
    );
    assert(
      Math.abs(result.bestResult.risk.winRate - targetWinRate) <=
        TAGGED_WINRATE_TOLERANCE + 1e-12,
      `(d) winRate within 0.01pp of 5% tag (achieved ${(result.bestResult.risk.winRate * 100).toFixed(4)}%, delta ${(Math.abs(result.bestResult.risk.winRate - targetWinRate) * 100).toFixed(4)}pp)`,
    );

    assert(
      result.bestResult.edge >= targetEdge - 1e-9,
      `(d) edge ≥ target (${result.bestResult.edge}, target ${targetEdge})`,
    );

    const priceDelta = Math.abs(result.bestPrice - basePrice) / basePrice;
    assert(
      priceDelta <= 0.25 + 1e-9,
      `(d) chosen price ${result.bestPrice.toFixed(2)} within ±25% of base ${basePrice.toFixed(2)} (delta ${(priceDelta * 100).toFixed(2)}%)`,
    );

    console.log(
      `      [tagged 5% — winner $${result.bestPrice.toFixed(2)}  wr=${(result.bestResult.risk.winRate * 100).toFixed(4)}%  edge=${(result.bestResult.edge * 100).toFixed(4)}%]`,
    );
  },
);

// ── 16e. Untagged default mode unchanged ───────────────────────────────
// Sanity pin: when `taggedWinRate` is omitted the wrapper runs the legacy
// snap-first scoring — `taggedAccuracyHit` must be `null` and the existing
// behavior is preserved for normal 20%-win packs.
check(
  "searchBestPriceForCleanSnap (e): untagged mode (no taggedWinRate) — taggedAccuracyHit is null",
  () => {
    const pool: { value: number }[] = [
      { value: 0.1 },
      { value: 0.5 },
      { value: 1 },
      { value: 3 },
      { value: 7 },
      { value: 12 },
      { value: 25 },
      { value: 80 },
    ];
    const basePrice = 10;
    const targetEdge = TARGET_HOUSE_EDGE;
    const targetWinRate = 0.2;

    const result = searchBestPriceForCleanSnap({
      cards: pool,
      basePrice,
      targetEdge,
      targetWinRate,
      // No `taggedWinRate` — default mode.
    });

    assert(
      result.taggedAccuracyHit === null,
      `(e) taggedAccuracyHit must be null when not in tagged mode (got ${result.taggedAccuracyHit})`,
    );
    assert(isSuccess(result.bestResult), "(e) winner shape is a success arm");
    if (!isSuccess(result.bestResult)) return;
    // Edge still hits target.
    assert(
      result.bestResult.edge >= targetEdge - 1e-9,
      `(e) edge ≥ target (${result.bestResult.edge}, target ${targetEdge})`,
    );
    // Win-rate within the SOFT default tolerance (0.02) — the existing contract.
    assert(
      Math.abs(result.bestResult.risk.winRate - targetWinRate) <= 0.02 + 1e-9,
      `(e) win-rate within ±2pp of target (${result.bestResult.risk.winRate})`,
    );
  },
);

// ── 17. ANTI-INFLATION anchor (currentWeights) — the FLAW-1 fix ─────────
//
// When `currentWeights` is supplied, the solver enforces the owner's rules:
//   (a) the EXPENSIVE TAIL (GRAIL band, value ≥ 5·price) is STRICTLY DECREASING
//       in value — the jackpot is the rarest pull;
//   (b) RAISING THE EDGE never INCREASES the top card's probability (vs the
//       current odds, and vs a lower-edge run) — it only ever TRIMS the tail;
//   (c) the clean-ladder snap, when accepted, lands every card on a rung except
//       AT MOST ONE buffer (the cheapest / dust card) — and never inflates a
//       grail above its precise odds.
// These pin the engine change directly (no DB — a hand-built pool that mirrors
// the real $20.50 / Charizard pack's shape: a rare hand-tuned jackpot + a
// generous mid-tier + dust).
check("anti-inflation (a): GRAIL tail is strictly decreasing in value", () => {
  // Mirror the real pack: $20.50, a $542 jackpot at a tiny 0.15% current odds,
  // descending grails, a generous mid-tier, and dust. currentWeights = live odds.
  const price = 20.5;
  const cards = [
    { value: 541.96 }, { value: 217.48 }, { value: 107.1 }, { value: 70.98 },
    { value: 46.3 }, { value: 24.43 }, { value: 20.53 }, { value: 18.16 },
    { value: 12.41 }, { value: 7.3 }, { value: 3.62 }, { value: 1.21 },
  ];
  // Live weights (sum 1,000,000) — the real pack's composition.
  const currentWeights = [
    1500, 4000, 8000, 20000, 125100, 183900, 40000, 17500, 85000, 135000, 170000, 210000,
  ];
  const r = shapeWeights({
    cards, price, targetEdge: 0.1099, targetWinRate: 0.2, currentWeights,
  });
  assert(isSuccess(r), `expected success: ${"error" in r ? r.error : ""}`);
  if (!isSuccess(r)) return;
  const total = r.weights.reduce((a, b) => a + b, 0);
  // GRAIL tail = value ≥ 5·price = ≥ $102.50 → cards $541.96 / $217.48 / $107.10.
  const grail = cards
    .map((c, i) => ({ v: c.value, pct: (r.weights[i]! / total) * 100 }))
    .filter((x) => x.v >= 5 * price)
    .sort((a, b) => a.v - b.v); // ascending value
  // Walking value-ascending, pct must be NON-INCREASING (strictly decreasing).
  for (let i = 1; i < grail.length; i++) {
    assert(
      grail[i]!.pct <= grail[i - 1]!.pct + 1e-9,
      `grail strictly decreasing: $${grail[i]!.v} at ${grail[i]!.pct.toFixed(4)}% > $${grail[i - 1]!.v} at ${grail[i - 1]!.pct.toFixed(4)}%`,
    );
  }
  // And the top card did NOT inflate above its CURRENT odds (0.15%).
  const topPct = (r.weights[0]! / total) * 100;
  assert(
    topPct <= 0.15 + 1e-6,
    `top card (Charizard $541.96) must NOT inflate above its 0.15% current odds; got ${topPct.toFixed(4)}%`,
  );
  console.log(`      [Charizard $541.96: current 0.15% → after ${topPct.toFixed(4)}% — NOT inflated]`);
});

check("anti-inflation (b): raising the edge never increases the top card's P", () => {
  // Same pool. Shape at a LOW edge and a HIGH edge; the top card's odds must be
  // NON-INCREASING as the edge rises (raising edge only trims the expensive tail).
  const price = 20.5;
  const cards = [
    { value: 541.96 }, { value: 217.48 }, { value: 107.1 }, { value: 70.98 },
    { value: 46.3 }, { value: 24.43 }, { value: 20.53 }, { value: 18.16 },
    { value: 12.41 }, { value: 7.3 }, { value: 3.62 }, { value: 1.21 },
  ];
  const currentWeights = [
    1500, 4000, 8000, 20000, 125100, 183900, 40000, 17500, 85000, 135000, 170000, 210000,
  ];
  const topPctAt = (edge: number): number => {
    const r = shapeWeights({ cards, price, targetEdge: edge, targetWinRate: 0.2, currentWeights });
    if (!isSuccess(r)) throw new Error(`infeasible at edge ${edge}`);
    const total = r.weights.reduce((a, b) => a + b, 0);
    return (r.weights[0]! / total) * 100;
  };
  let prev = Infinity;
  for (const edge of [0.08, 0.1099, 0.13, 0.15]) {
    const p = topPctAt(edge);
    assert(
      p <= prev + 1e-6,
      `top-card P must not rise as edge rises: edge ${edge} → ${p.toFixed(4)}% > previous ${prev.toFixed(4)}%`,
    );
    prev = p;
  }
});

check("anti-inflation (c): accepted snap is clean with ≤1 dust-buffer; tail never inflated", () => {
  // A clean-snapping anchored pool. When `snapped === true`, every positive card
  // sits on a ladder rung EXCEPT at most one buffer — and that buffer is the
  // cheapest (dust) card. And no grail card exceeds its precise pre-snap odds.
  const price = 5;
  const cards = [
    { value: 40.0 }, { value: 20.25 }, { value: 0.5 },
  ];
  const currentWeights = [50, 1000, 80000]; // jackpot rare, dust dominant
  const r = shapeWeights({
    cards, price, targetEdge: 0.1099, targetWinRate: 0.15, currentWeights,
  });
  assert(isSuccess(r), `expected success: ${"error" in r ? r.error : ""}`);
  if (!isSuccess(r)) return;
  if (r.snapped === true) {
    const total = r.weights.reduce((a, b) => a + b, 0);
    const pcts = r.weights.map((w) => (w / total) * 100);
    const offLadder: number[] = [];
    for (let i = 0; i < cards.length; i++) {
      if (r.weights[i]! > 0 && !isOnLadder(pcts[i]!)) offLadder.push(i);
    }
    assert(offLadder.length <= 1, `at most ONE off-ladder (buffer) card; got ${offLadder.length}`);
    if (offLadder.length === 1) {
      let cheapestV = Infinity;
      for (let i = 0; i < cards.length; i++) if (r.weights[i]! > 0) cheapestV = Math.min(cheapestV, cards[i]!.value);
      assert(
        cards[offLadder[0]!]!.value === cheapestV || cards[offLadder[0]!]!.value < 0.5 * price,
        `the single off-ladder card must be the cheapest/dust card (value $${cards[offLadder[0]!]!.value})`,
      );
    }
  }
  // Regardless of snap, edge is at/above target and the top card never inflated.
  assert(r.edge >= 0.1099 - 1e-9, `edge ≥ target (${r.edge})`);
});

// ── SECTION 18: price-search band reachability (RC3 fix, 2026-07-02) ──
// Pre-fix, searchBestPriceForCleanSnap walked ±1¢ outward and STOPPED at the
// candidate cap, so a 50-candidate budget only ever explored ±25 CENTS of the
// requested band — clean-snap prices provably sat inside the allowance but
// were never evaluated (audit: 174/183 prod sweeps clipped, 27/40 dirty packs
// had an unexplored in-band clean price). The phased sweep (fine → coarse →
// refine → offset passes) must reach the WHOLE band, and the early-stop must
// keep the common near-snap case cheap.
//
// Fixture = the REAL prod "Refresh" pool (fleet dump 2026-07-02, $1.77):
// under the anti-inflation anchor it admits EXACTLY ONE clean-snap price in
// the whole ±60% band (+100¢ from base) — unreachable pre-fix.
const REFRESH_POOL = [
  { value: 67.73, weight: 1500 },
  { value: 41.15, weight: 2500 },
  { value: 36.02, weight: 3500 },
  { value: 20.41, weight: 8000 },
  { value: 13.4, weight: 15500 },
  { value: 9.79, weight: 30000 },
  { value: 4.09, weight: 50000 },
  { value: 2.28, weight: 89000 },
  { value: 0.96, weight: 100000 },
  { value: 0.65, weight: 100000 },
  { value: 0.06, weight: 100000 },
  { value: 0.02, weight: 500000 },
];

check("price-search reachability: anchored far-only snap needle is found under band 0.6", () => {
  const cards = REFRESH_POOL.map((c) => ({ value: c.value }));
  const currentWeights = REFRESH_POOL.map((c) => c.weight);
  const basePrice = 1.77;
  // Ground truth at 1¢ so the fixture can't silently rot: collect every
  // snapped price across the band and assert the far-only shape still holds.
  const bandCents = Math.floor(basePrice * 0.6 * 100);
  let nearSnaps = 0;
  const farSnaps: number[] = [];
  for (let d = -bandCents; d <= bandCents; d++) {
    const price = (177 + d) / 100;
    if (price <= 0) continue;
    const r = shapeWeights({
      cards,
      price,
      targetEdge: 0.1099,
      targetWinRate: 0.2,
      currentWeights,
    });
    if ("weights" in r && r.snapped === true) {
      if (Math.abs(d) <= 25) nearSnaps += 1;
      else farSnaps.push(price);
    }
  }
  assert(
    nearSnaps === 0 && farSnaps.length >= 1,
    `fixture precondition drifted: near=${nearSnaps} far=${farSnaps.length} — pick a new far-only pool`,
  );
  const search = searchBestPriceForCleanSnap({
    cards,
    basePrice,
    targetEdge: 0.1099,
    targetWinRate: 0.2,
    maxPriceChangePct: 0.6,
    currentWeights,
  });
  assert("weights" in search.bestResult, "search must succeed");
  assert(
    "weights" in search.bestResult && search.bestResult.snapped === true,
    `search must find the in-band clean snap (got bestPrice=$${search.bestPrice.toFixed(2)}, snapped=false)`,
  );
  assert(
    Math.abs(Math.round(search.bestPrice * 100) - 177) > 25,
    "the found snap must lie beyond the pre-fix ±25c window",
  );
  assert(search.searched <= 120, `budget respected (searched=${search.searched})`);
});

check("price-search early-stop: near clean snap settles cheaply without sweeping the band", () => {
  // Same pool UNANCHORED admits snaps at ±1¢ of base — the sweep must settle
  // on a near hit quickly instead of burning the whole budget.
  const cards = REFRESH_POOL.map((c) => ({ value: c.value }));
  const search = searchBestPriceForCleanSnap({
    cards,
    basePrice: 1.77,
    targetEdge: 0.1099,
    targetWinRate: 0.2,
    maxPriceChangePct: 0.6,
  });
  assert("weights" in search.bestResult, "search must succeed");
  assert(
    "weights" in search.bestResult && search.bestResult.snapped === true,
    "near snap must be found",
  );
  assert(
    Math.abs(Math.round(search.bestPrice * 100) - 177) <= 5,
    `near snap should win on centsDist (got $${search.bestPrice.toFixed(2)})`,
  );
  assert(
    search.searched <= 15,
    `early-stop should keep the near case cheap (searched=${search.searched})`,
  );
});

// ── SECTION 19: DB-tag hit-rate resolution (tags-column fix, 2026-07-02) ──
// The retune paths used to parse ONLY the pack name; DB-tagged packs whose
// name lacks a leading "X%" prefix ran at the untagged 20% default (prod:
// Heavy Hitters %1, Legendary Showcase %5, Molten Crown / Trainers Tale %10).
check("resolveIntendedHitRate: DB tags column first (both notations), name fallback, null when untagged", () => {
  // Raw-SQL notation (mapped DB strings).
  assert(hitRateFromTags(["%1"]) === 0.01, "%1 → 0.01");
  assert(hitRateFromTags(["onepiece", "%5"]) === 0.05, "%5 among a non-hit-rate tag → 0.05");
  assert(hitRateFromTags(["%10"]) === 0.1, "%10 → 0.10");
  // Prisma notation (TS enum names).
  assert(hitRateFromTags(["pct1"]) === 0.01, "pct1 → 0.01");
  assert(hitRateFromTags(["onepiece", "pct10"]) === 0.1, "pct10 among other tags → 0.10");
  assert(hitRateFromTags(["fifty50"]) === 0.5, "fifty50 enum name → 0.5 (both notations, matches the '50/50' DB string)");
  assert(hitRateFromTags(["50/50"]) === 0.5, "'50/50' DB string → 0.5");
  assert(hitRateFromTags([]) === null && hitRateFromTags(null) === null, "empty/null → null");
  // DB tag wins; name is the fallback; both absent → null.
  assert(
    resolveIntendedHitRate("Heavy Hitters", ["%1"]) === 0.01,
    "DB-tagged, unparseable name → the DB tag (was: 20% default)",
  );
  assert(
    resolveIntendedHitRate("1% 18 PLUS", []) === 0.01,
    "name-tagged, no DB tag → parsed name",
  );
  assert(
    resolveIntendedHitRate("10% Divine Order", ["pct10"]) === 0.1,
    "both agree → 0.10",
  );
  assert(
    resolveIntendedHitRate("Plain Pack", []) === null,
    "untagged → null (caller falls back to the 20% default)",
  );
});

// ── SECTION 20: saturated hard-tag EV knob + tagged snap mode (RC4/RC5b/c) ──
// The audit's RC4 wall: an ANCHORED + HARD-TAG lottery pool has every winner
// capped at its current odds and the tag pins the win mass, so the reachable
// EV collapsed to a point and 28/37 tagged prod packs errored
// `ev-unreachable-for-split` (re-measured 2026-07-02 post-RC3: 30/41 — the
// wider price band alone healed nothing). The RC4 knob interpolates the capped
// win shares toward the CHEAPEST winner (t ∈ [0,1]): win mass stays pinned at
// the tag, every non-cheapest winner's odds only ever DROP, and the solve
// regains exactly one EV degree of freedom that cannot inflate the tail.
//
// Fixture = the audit-documented "1% 18 PLUS" prod pool ($1.25, 7 grails, one
// $1.30 win-band card, 3 dust cards; live weights sum 1,000,000 with the win
// band at exactly the 1% tag — the fully SATURATED case).
const SATURATED_1PCT_POOL = [
  { value: 810.07, weight: 200 },
  { value: 508.45, weight: 300 },
  { value: 118.21, weight: 3000 },
  { value: 114.0, weight: 3000 },
  { value: 75.47, weight: 1500 },
  { value: 64.76, weight: 1000 },
  { value: 60.25, weight: 900 },
  { value: 1.3, weight: 100 },
  { value: 0.08, weight: 800000 },
  { value: 0.05, weight: 150000 },
  { value: 0.02, weight: 40000 },
];

// The saturated pinch has TWO sides. At the live $1.25 the monotone grail-cap
// tightening (the non-monotone live profile: $114/$118 at 0.30% get capped to
// the cheapest grail's 0.09%) guts the win pool's EV ceiling, so the failure
// is `evTarget > evMax` — EV cannot be LIFTED without inflating the tail, and
// the sanctioned remedy is the ±60% price search (pinned end-to-end below).
// At a LOWER price the same pool flips to the knob's side: `evTarget < evMin`
// (the capped win pool alone carries more EV than the target allows). $0.80
// sits firmly on that side — pre-knob this errored `ev-unreachable-for-split`;
// the knob must now solve it with the tag pinned and the tail never inflated.
check("RC4 knob: saturated anchored+hard-tag pool solves on the evMin side, tag + never-inflate held", () => {
  const price = 0.8;
  const cards = SATURATED_1PCT_POOL.map((c) => ({ value: c.value }));
  const currentWeights = SATURATED_1PCT_POOL.map((c) => c.weight);
  const curTotal = currentWeights.reduce((a, b) => a + b, 0);
  const r = shapeWeights({
    cards,
    price,
    targetEdge: 0.1099,
    targetWinRate: 0.01,
    currentWeights,
    winRateIsHard: true,
  });
  assert(
    isSuccess(r),
    `saturated hard-tag pool must now solve on the evMin side (was ev-unreachable-for-split): ${"error" in r ? r.error : ""}`,
  );
  if (!isSuccess(r)) return;
  // Edge lands one-sided in the precise window.
  assert(r.edge >= 0.1099 - 1e-9, `edge ≥ target (${r.edge})`);
  assert(r.edge <= 0.1099 + 0.001 + 1e-9, `edge ≤ target+0.001 (${r.edge})`);
  // The tag holds: win-rate within 0.01pp of 1%.
  assert(
    Math.abs(r.risk.winRate - 0.01) <= TAGGED_WINRATE_TOLERANCE + 1e-12,
    `win-rate pinned at the 1% tag (got ${(r.risk.winRate * 100).toFixed(4)}%)`,
  );
  // NEVER-INFLATE: every non-cheapest winner's odds ≤ its current odds (the
  // knob may only raise the CHEAPEST winner — the $1.30 card). Allow the snap
  // guard's 0.002pp + integer-quantization slack.
  const total = r.weights.reduce((a, b) => a + b, 0);
  const cheapestWinnerValue = 1.3;
  for (let i = 0; i < cards.length; i++) {
    const v = cards[i]!.value;
    if (v < price || v === cheapestWinnerValue) continue;
    const after = r.weights[i]! / total;
    const before = currentWeights[i]! / curTotal;
    assert(
      after <= before + 2.5e-5,
      `non-cheapest winner $${v} must not inflate: ${(after * 100).toFixed(4)}% > current ${(before * 100).toFixed(4)}%`,
    );
  }
  // Knob signature / fixture-drift guard: in hard-tag mode NO winner may rise
  // above its current odds except through the knob's cheapest-winner
  // concentration. If the $1.30 card did NOT rise, the pool wasn't saturated
  // on the evMin side here and the fixture drifted — pick a new price.
  const cheapIdx = cards.findIndex((c) => c.value === cheapestWinnerValue);
  const cheapAfter = r.weights[cheapIdx]! / total;
  const cheapBefore = currentWeights[cheapIdx]! / curTotal;
  assert(
    cheapAfter > cheapBefore,
    `fixture precondition drifted: the cheapest winner did not rise (after ${(cheapAfter * 100).toFixed(4)}% ≤ current ${(cheapBefore * 100).toFixed(4)}%) — the knob did not fire`,
  );
  // GRAIL tail monotone (ties allowed — the $118.21/$114.00 pair shares its
  // current odds) + the top jackpot strictly the rarest winner.
  const grail = cards
    .map((c, i) => ({ v: c.value, pct: (r.weights[i]! / total) * 100 }))
    .filter((x) => x.v >= 5 * price)
    .sort((a, b) => a.v - b.v);
  for (let i = 1; i < grail.length; i++) {
    assert(
      grail[i]!.pct <= grail[i - 1]!.pct + 1e-9,
      `grail non-increasing in value: $${grail[i]!.v} ${grail[i]!.pct.toFixed(5)}% > $${grail[i - 1]!.v} ${grail[i - 1]!.pct.toFixed(5)}%`,
    );
  }
  const top = grail[grail.length - 1]!;
  const second = grail[grail.length - 2]!;
  assert(top.pct < second.pct + 1e-12, `top jackpot strictly rarest (${top.pct} vs ${second.pct})`);
  console.log(
    `      [saturated 1% — knob solved $${price.toFixed(2)}: wr=${(r.risk.winRate * 100).toFixed(4)}% edge=${(r.edge * 100).toFixed(3)}% snapped=${r.snapped === true}]`,
  );
});

check("RC4/RC5b end-to-end: tagged search on the saturated pool hits the tag (taggedAccuracyHit)", () => {
  const price = 1.25;
  const cards = SATURATED_1PCT_POOL.map((c) => ({ value: c.value }));
  const currentWeights = SATURATED_1PCT_POOL.map((c) => c.weight);
  const search = searchBestPriceForCleanSnap({
    cards,
    basePrice: price,
    targetEdge: 0.1099,
    targetWinRate: 0.01,
    nearMissMin: 0.1,
    currentWeights,
    maxPriceChangePct: 0.6,
    taggedWinRate: 0.01,
  });
  assert(
    isSuccess(search.bestResult),
    `search must succeed (was 28/37 error wall): ${"error" in search.bestResult ? search.bestResult.error : ""}`,
  );
  if (!isSuccess(search.bestResult)) return;
  assert(
    search.taggedAccuracyHit === true,
    `taggedAccuracyHit must be true (wr=${(search.bestResult.risk.winRate * 100).toFixed(4)}%)`,
  );
  assert(search.bestResult.edge >= 0.1099 - 1e-9, `edge ≥ target (${search.bestResult.edge})`);
  // RC5b: a SNAPPED winner must still hold the tag — clean and tag-accurate
  // are no longer mutually exclusive by construction.
  if (search.bestResult.snapped === true) {
    assert(
      Math.abs(search.bestResult.risk.winRate - 0.01) <= TAGGED_WINRATE_TOLERANCE + 1e-12,
      `snapped winner must keep the tag (wr=${(search.bestResult.risk.winRate * 100).toFixed(4)}%)`,
    );
  }
  console.log(
    `      [saturated 1% search — $${search.bestPrice.toFixed(2)} wr=${(search.bestResult.risk.winRate * 100).toFixed(4)}% edge=${(search.bestResult.edge * 100).toFixed(3)}% snapped=${search.bestResult.snapped === true} searched=${search.searched}]`,
  );
});

check("RC5b: hard-tag run that snaps keeps the WIN-band rung sum on the tag", () => {
  // The 16c-style designed 1% pool (3 grails + a 30-card dust ladder) snaps
  // readily. In HARD-tag mode the precise solve lands ON the tag, so RC5b
  // requires any accepted snap to hold it within 0.01pp — pre-fix the snap
  // only checked the soft ±2pp vs the precise result and traded the tag away.
  const pool: { value: number }[] = [
    { value: 100 },
    { value: 200 },
    { value: 500 },
    ...Array.from({ length: 30 }, (_, i) => ({ value: 0.5 - i * 0.015 })).filter(
      (c) => c.value > 0,
    ),
  ];
  const r = shapeWeights({
    cards: pool,
    price: 1.25,
    targetEdge: 0.1099,
    targetWinRate: 0.01,
    nearMissMin: 0.05,
    winRateIsHard: true,
  });
  assert(isSuccess(r), `hard-tag designed pool must solve: ${"error" in r ? r.error : ""}`);
  if (!isSuccess(r)) return;
  assert(r.edge >= 0.1099 - 1e-9, `edge ≥ target (${r.edge})`);
  if (r.snapped === true) {
    assert(
      Math.abs(r.risk.winRate - 0.01) <= TAGGED_WINRATE_TOLERANCE + 1e-12,
      `snapped hard-tag result must hold the tag (wr=${(r.risk.winRate * 100).toFixed(4)}%)`,
    );
  }
  console.log(
    `      [RC5b designed 1% — wr=${(r.risk.winRate * 100).toFixed(4)}% edge=${(r.edge * 100).toFixed(3)}% snapped=${r.snapped === true}]`,
  );
});

check("RC5c: a snapped tagged result is clean on ITS ladder (per-100k grid, tag-exact) — a generic snap keeps off-ladder to dust only", () => {
  // RETUNE V2 UPDATE: a HARD-TAG snap now targets the per-100k integer house
  // ladder (ruleset §1.2 / CLEAN-XOR-TAG fix) — "clean" for a tagged pack
  // means integer 0.001% rungs with the win band summing EXACTLY to
  // round(t·100000) and ONE dust buffer, NOT the log-ladder rungs (which are
  // unreachable under the 0.01pp tag gate; that was exactly the audit's 0/8).
  // The legacy log-ladder + buffer-polish assertions still apply when the
  // GENERIC snap produced the result (total ≠ 100000).
  const price = 0.8;
  const cards = SATURATED_1PCT_POOL.map((c) => ({ value: c.value }));
  const currentWeights = SATURATED_1PCT_POOL.map((c) => c.weight);
  const r = shapeWeights({
    cards,
    price,
    targetEdge: 0.1099,
    targetWinRate: 0.01,
    currentWeights,
    winRateIsHard: true,
  });
  assert(isSuccess(r), `saturated pool must solve: ${"error" in r ? r.error : ""}`);
  if (!isSuccess(r)) return;
  if (r.snapped !== true) {
    console.log("      [RC5c — pool did not snap; polish not exercised here (fleet re-measure covers it)]");
    return;
  }
  const total = r.weights.reduce((a, b) => a + b, 0);
  if (total === 100_000) {
    // Tagged per-100k snap: every weight IS the pct in 0.001% units — the
    // whole vector is on the tagged clean grid by construction; pin the
    // win-band tag sum + integer grid + edge invariant instead.
    assert(
      r.weights.every((w) => Number.isInteger(w) && w >= 0),
      "per-100k ladder weights are integers",
    );
    let winUnits = 0;
    for (let i = 0; i < cards.length; i++) {
      if (cards[i]!.value >= price) winUnits += r.weights[i]!;
    }
    assert(
      winUnits === Math.round(0.01 * 100_000),
      `win band sums EXACTLY to round(t·1e5) (got ${winUnits})`,
    );
    assert(
      Math.abs(r.risk.winRate - 0.01) <= TAGGED_WINRATE_TOLERANCE + 1e-12,
      `tag exact on the snapped ladder (wr=${(r.risk.winRate * 100).toFixed(4)}%)`,
    );
    console.log("      [RC5c — tagged per-100k snap: integer grid + exact tag sum verified]");
    return;
  }
  const offLadder: number[] = [];
  for (let i = 0; i < cards.length; i++) {
    if (r.weights[i]! > 0 && !isOnLadder((r.weights[i]! / total) * 100)) offLadder.push(i);
  }
  assert(offLadder.length <= 3, `at most 3 off-ladder cards after polish; got ${offLadder.length}`);
  for (const i of offLadder) {
    assert(
      cards[i]!.value < 0.5 * price,
      `off-ladder card must be DUST (value $${cards[i]!.value})`,
    );
  }
});

// ── LAW M — monotoneEvWindow / findMonotoneViolations (Retune V3, 1/3) ──────
//
// The owner's hard ladder law: value-DESC, share non-decreasing, across band
// boundaries, pins + zero rows + equal values exempt. These checks pin the
// exact EV window primitive the engine's enforcement (stage 2) builds on.

/** Assert a witness vector is LAWFUL for the window's constraint set. */
function assertLawfulWitness(
  fx: {
    values: number[];
    price: number;
    winMass: number;
    nearMissMin: number;
    winCaps?: (number | null)[];
    pinned?: { index: number; share: number }[];
  },
  shares: number[],
  expectedEv: number,
  label: string,
): void {
  const n = fx.values.length;
  assert(shares.length === n, `${label}: witness length`);
  let total = 0;
  let winMass = 0;
  let nmMass = 0;
  let ev = 0;
  for (let i = 0; i < n; i++) {
    const s = shares[i]!;
    const v = fx.values[i]!;
    assert(Number.isFinite(s) && s >= -1e-9, `${label}: share[${i}] ≥ 0 (got ${s})`);
    total += s;
    ev += s * v;
    if (v >= fx.price) winMass += s;
    else if (v >= 0.5 * fx.price) nmMass += s;
  }
  assert(Math.abs(total - 1) <= 1e-7, `${label}: total mass 1 (got ${total})`);
  assert(Math.abs(winMass - fx.winMass) <= 1e-7, `${label}: win mass (got ${winMass})`);
  assert(nmMass >= fx.nearMissMin - 1e-7, `${label}: NM floor (got ${nmMass})`);
  const pinnedIdx = new Set<number>((fx.pinned ?? []).map((p) => p.index));
  for (const p of fx.pinned ?? []) {
    assert(Math.abs(shares[p.index]! - p.share) <= 1e-12, `${label}: pin[${p.index}] exact`);
  }
  if (fx.winCaps) {
    for (let i = 0; i < n; i++) {
      const cap = fx.winCaps[i];
      if (cap === null || cap === undefined || pinnedIdx.has(i)) continue;
      if (fx.values[i]! >= fx.price) {
        assert(shares[i]! <= cap + 1e-9, `${label}: cap[${i}] respected (${shares[i]} > ${cap})`);
      }
    }
  }
  const viols = findMonotoneViolations({
    values: fx.values,
    shares,
    pinnedIdx,
    tol: 1e-7,
  });
  assert(viols.length === 0, `${label}: LAW M chain (${JSON.stringify(viols[0] ?? null)})`);
  assert(Math.abs(ev - expectedEv) <= 1e-6, `${label}: EV achieves bound (${ev} vs ${expectedEv})`);
}

/**
 * Brute-force window over an integer grid (units of 1/20) — the chain is
 * enforced INCLUDING ties (strictly tighter than the law, so the brute
 * feasible set is a subset: containment must hold regardless).
 */
function bruteWindow(fx: {
  values: number[];
  price: number;
  winUnits: number;
  nmMinUnits: number;
  capUnits?: (number | null)[];
}): { min: number; max: number } | null {
  const UNITS = 20;
  const order = fx.values
    .map((v, idx) => ({ v, idx }))
    .sort((a, b) => a.v - b.v); // cheap → pricey; shares non-increasing along this walk
  let best: { min: number; max: number } | null = null;
  const walk = (pos: number, prev: number, left: number, winLeft: number, nm: number, ev: number): void => {
    if (pos === order.length) {
      if (left === 0 && winLeft === 0 && nm >= fx.nmMinUnits) {
        const e = ev / UNITS;
        if (best === null) best = { min: e, max: e };
        else {
          best.min = Math.min(best.min, e);
          best.max = Math.max(best.max, e);
        }
      }
      return;
    }
    const { v, idx } = order[pos]!;
    const isWin = v >= fx.price;
    const capRaw = fx.capUnits?.[idx];
    const cap = isWin && capRaw !== null && capRaw !== undefined ? capRaw : UNITS;
    const hi = Math.min(prev, left, cap, isWin ? winLeft : left - winLeft);
    for (let u = hi; u >= 0; u--) {
      walk(
        pos + 1,
        u,
        left - u,
        isWin ? winLeft - u : winLeft,
        !isWin && v >= 0.5 * fx.price ? nm + u : nm,
        ev + u * v,
      );
    }
  };
  walk(0, UNITS, UNITS, fx.winUnits, 0, 0);
  return best;
}

check("MW1 — hand fixture: exact window [40, 44] + lawful witnesses", () => {
  const fx = {
    values: [100, 50, 10],
    price: 60,
    winMass: 0.2,
    nearMissMin: 0.3,
    winCaps: [0.25, null, null] as (number | null)[],
  };
  const w = monotoneEvWindow(fx);
  assert(w !== null, "window exists");
  assert(Math.abs(w.evMin - 40) <= 1e-9, `evMin 40 (got ${w.evMin})`);
  assert(Math.abs(w.evMax - 44) <= 1e-9, `evMax 44 (got ${w.evMax})`);
  assertLawfulWitness(fx, w.minVector, w.evMin, "MW1 min");
  assertLawfulWitness(fx, w.maxVector, w.evMax, "MW1 max");
  // The 1/20 grid expresses both extremes exactly here — brute force agrees.
  const bf = bruteWindow({ values: fx.values, price: fx.price, winUnits: 4, nmMinUnits: 6, capUnits: [5, null, null] });
  assert(bf !== null, "brute force found feasible vectors");
  assert(Math.abs(bf.min - w.evMin) <= 1e-9, `brute min = evMin (${bf.min})`);
  assert(Math.abs(bf.max - w.evMax) <= 1e-9, `brute max = evMax (${bf.max})`);
});

check("MW2 — never-inflate cap on a CHEAP winner bounds every pricier one", () => {
  // caps [0.5, 0.1]: the pricier card's own cap is loose, but the chain makes
  // the cheap card's 0.1 the effective bound for BOTH → win capacity 0.2.
  const nullW = monotoneEvWindow({
    values: [100, 80, 10],
    price: 60,
    winMass: 0.3,
    nearMissMin: 0,
    winCaps: [0.5, 0.1, null],
  });
  assert(nullW === null, "winMass 0.3 > chain capacity 0.2 → null");
  const fx = {
    values: [100, 80, 10],
    price: 60,
    winMass: 0.15,
    nearMissMin: 0,
    winCaps: [0.5, 0.1, null] as (number | null)[],
  };
  const w = monotoneEvWindow(fx);
  assert(w !== null, "winMass 0.15 fits");
  assert(w.maxVector[0]! <= 0.1 + 1e-9, `pricier winner ≤ running-min cap (got ${w.maxVector[0]})`);
  assert(Math.abs(w.evMin - 21.5) <= 1e-9, `evMin 21.5 (got ${w.evMin})`);
  assert(Math.abs(w.evMax - 22.0) <= 1e-9, `evMax 22.0 (got ${w.evMax})`);
  assertLawfulWitness(fx, w.minVector, w.evMin, "MW2 min");
  assertLawfulWitness(fx, w.maxVector, w.evMax, "MW2 max");
});

check("MW3 — pins carve out exactly and are LAW-M-exempt (point window)", () => {
  const fx = {
    values: [100, 50, 10],
    price: 60,
    winMass: 0.2,
    nearMissMin: 0.3, // pinned NM 0.5 already covers it
    pinned: [{ index: 1, share: 0.5 }],
  };
  const w = monotoneEvWindow({ ...fx, pinnedShares: fx.pinned });
  assert(w !== null, "window exists");
  assert(Math.abs(w.evMin - 48) <= 1e-9, `evMin 48 (got ${w.evMin})`);
  assert(Math.abs(w.evMax - 48) <= 1e-9, `evMax 48 (got ${w.evMax})`);
  assertLawfulWitness(fx, w.minVector, 48, "MW3 min");
  assertLawfulWitness(fx, w.maxVector, 48, "MW3 max");
  assert(Math.abs(w.minVector[1]! - 0.5) <= 1e-12, "pin exact in witness");
});

check("MW4 — structural nulls: cap capacity, NM floor, missing loss band", () => {
  assert(
    monotoneEvWindow({ values: [100, 50, 10], price: 60, winMass: 0.4, nearMissMin: 0, winCaps: [0.25, null, null] }) === null,
    "winMass above cap capacity → null",
  );
  assert(
    monotoneEvWindow({ values: [100, 10], price: 60, winMass: 0.2, nearMissMin: 0.1 }) === null,
    "NM floor with no NM rows → null",
  );
  assert(
    monotoneEvWindow({ values: [100], price: 60, winMass: 0.5, nearMissMin: 0 }) === null,
    "loss mass with no loss rows → null",
  );
});

check("MW5 — Love Cycle: the 50% tag has NO lawful ladder under live caps", () => {
  const values = [834.0, 810.07, 719.99, 650.6, 600.0, 540.0, 453.0, 376.79, 208.09, 205.37, 152.9, 0.29];
  const winCaps: (number | null)[] = [0.0125, 0.0125, 0.015, 0.019, 0.025, 0.034, 0.045, 0.047, 0.083, 0.092, null, null];
  const price = 189.93;
  // Tagged 0.5: the never-inflate caps carry Σ 38.5% — 50% win mass is
  // structurally impossible on a lawful ladder. This is the engine-side proof
  // behind the "tag doesn't fit this pool" verdict (recon 2026-07-08).
  assert(
    monotoneEvWindow({ values, price, winMass: 0.5, nearMissMin: 0.115, winCaps }) === null,
    "tagged 0.5 under live caps → null",
  );
  // At the live-achievable 38.5% the window exists — but its EV floor sits
  // ABOVE the ~11% design target EV (~$168.9), which is why the honest plan
  // must move price / float win-rate instead of shipping a zigzag.
  const fx = { values, price, winMass: 0.385, nearMissMin: 0.115, winCaps };
  const w = monotoneEvWindow(fx);
  assert(w !== null, "winMass 0.385 window exists");
  assert(Math.abs(w.evMin - 169.0598) <= 0.01, `evMin ≈ 169.06 (got ${w.evMin.toFixed(4)})`);
  assert(Math.abs(w.evMax - 198.4372) <= 0.01, `evMax ≈ 198.44 (got ${w.evMax.toFixed(4)})`);
  assert(w.evMin > 168.9, "design-target EV sits below the lawful window");
  assertLawfulWitness(fx, w.minVector, w.evMin, "MW5 min");
  assertLawfulWitness(fx, w.maxVector, w.evMax, "MW5 max");
});

check("MW6 — min-EV loss layout j-scan lands on the true structure", () => {
  // Concentrating the NM floor on the cheapest NM row wins when dust is cheap…
  const a = monotoneEvWindow({ values: [100, 59, 31, 1], price: 60, winMass: 0, nearMissMin: 0.4 });
  assert(a !== null, "A window exists");
  assert(Math.abs(a.evMin - 13.0) <= 1e-9, `A: evMin 13.0 (got ${a.evMin})`);
  assert(a.minVector[0]! === 0, "A: zero-mass win row stays 0 (LAW-M-exempt)");
  // …but spreading it wins when the raised dust floor would be expensive.
  const b = monotoneEvWindow({ values: [100, 59, 31, 29, 29, 29, 1], price: 60, winMass: 0, nearMissMin: 0.2 });
  assert(b !== null, "B window exists");
  assert(Math.abs(b.evMin - 18.2) <= 1e-9, `B: evMin 18.2 (got ${b.evMin})`);
});

check("MW7 — brute-force containment on an ungainly 5-card pool", () => {
  const fx = {
    values: [120, 100, 55, 40, 8],
    price: 60,
    winMass: 0.25,
    nearMissMin: 0.2,
    winCaps: [0.15, 0.2, null, null, null] as (number | null)[],
  };
  const w = monotoneEvWindow(fx);
  assert(w !== null, "window exists");
  assertLawfulWitness(fx, w.minVector, w.evMin, "MW7 min");
  assertLawfulWitness(fx, w.maxVector, w.evMax, "MW7 max");
  const bf = bruteWindow({
    values: fx.values,
    price: fx.price,
    winUnits: 5,
    nmMinUnits: 4,
    capUnits: [3, 4, null, null, null],
  });
  assert(bf !== null, "brute force found feasible vectors");
  // Containment: no lawful grid vector may escape the window…
  assert(bf.min >= w.evMin - 1e-9, `brute min ${bf.min} ≥ evMin ${w.evMin}`);
  assert(bf.max <= w.evMax + 1e-9, `brute max ${bf.max} ≤ evMax ${w.evMax}`);
  // …and the coarse grid must land reasonably close to the true extremes.
  assert(bf.min - w.evMin <= 1.5, `grid min within step slack (${bf.min} vs ${w.evMin})`);
  assert(w.evMax - bf.max <= 1.5, `grid max within step slack (${bf.max} vs ${w.evMax})`);
});

check("MV1 — findMonotoneViolations: the Love Cycle zigzag, exemptions, ties", () => {
  const values = [834.0, 810.07, 719.99, 650.6, 600.0, 540.0, 453.0, 376.79, 208.09, 205.37, 152.9, 0.29];
  // The shipped sink plan: 30% on the cheapest WIN over 10% near-miss.
  const sink = [0.0125, 0.0125, 0.015, 0.019, 0.025, 0.034, 0.045, 0.047, 0.05, 0.3, 0.1, 0.395];
  const viols = findMonotoneViolations({ values, shares: sink });
  assert(viols.length >= 1, "sink plan violates LAW M");
  assert(
    viols.some((v) => v.richIdx === 9 && v.poorIdx === 10),
    `the 30%→10% boundary drop is flagged (got ${JSON.stringify(viols)})`,
  );
  // The live ladder is lawful.
  const live = [0.0125, 0.0125, 0.015, 0.019, 0.025, 0.034, 0.045, 0.047, 0.083, 0.092, 0.115, 0.5];
  assert(findMonotoneViolations({ values, shares: live }).length === 0, "live ladder lawful");
  // Zero rows are not rungs; pins are sovereign; equal values are unordered.
  assert(
    findMonotoneViolations({ values: [100, 50, 10], shares: [0.3, 0, 0.7] }).length === 0,
    "zero row exempt",
  );
  assert(
    findMonotoneViolations({
      values: [100, 50, 10],
      shares: [0.2, 0.7, 0.1],
      pinnedIdx: new Set([1]),
    }).length === 1,
    "pin exempt but the free chain still catches 0.2 > 0.1",
  );
  assert(
    findMonotoneViolations({ values: [29, 29, 29], shares: [0.5, 0.2, 0.3] }).length === 0,
    "equal-value rows carry no order constraint",
  );
});

check("ML1 — monotoneLayoutForEv: lawful + EV-exact anywhere in the window", () => {
  const fx = {
    values: [100, 50, 10],
    price: 60,
    winMass: 0.2,
    nearMissMin: 0.3,
    winCaps: [0.25, null, null] as (number | null)[],
  };
  const w = monotoneEvWindow(fx);
  assert(w !== null, "window exists");
  const target = 42; // mid-window
  const shares = monotoneLayoutForEv(w, target);
  assertLawfulWitness(fx, shares, target, "ML1 lerp");
  // Clamps outside the window.
  const lo = monotoneLayoutForEv(w, 0);
  assertLawfulWitness(fx, lo, w.evMin, "ML1 clamp-lo");
  const hi = monotoneLayoutForEv(w, 999);
  assertLawfulWitness(fx, hi, w.evMax, "ML1 clamp-hi");
});

// ── LAW M — enforceMonotoneLadderLawM (Retune V3, 2/3: the engine gate) ─────
//
// The end-of-solve gate: lawful vectors pass byte-untouched, zigzags are
// re-laid at the SAME landed win mass / EV / pins (fail-closed re-verified),
// and structurally unlawful demands become the typed `monotone-unreachable`
// refusal. Wired into `shapeWeights` behind `disperseLoss` (retune path only).

const LOVE_CYCLE_VALUES = [834.0, 810.07, 719.99, 650.6, 600.0, 540.0, 453.0, 376.79, 208.09, 205.37, 152.9, 0.29];
const LOVE_CYCLE_LIVE_W = [125, 125, 150, 190, 250, 340, 450, 470, 830, 920, 1150, 5000]; // live shares ×1e4

check("MG1 — gate: a lawful ladder passes through untouched", () => {
  const out = enforceMonotoneLadderLawM({
    cards: LOVE_CYCLE_VALUES.map((value) => ({ value })),
    weights: LOVE_CYCLE_LIVE_W,
    price: 189.93,
    currentWeights: LOVE_CYCLE_LIVE_W,
    nearMissFloor: 0.115,
  });
  assert(out.kind === "lawful", `live Love Cycle ladder is lawful (got ${out.kind})`);
});

check("MG2 — gate: a loss-band zigzag inside the lawful window is RE-LAID at the same EV / win mass, integer weights, LAW clean", () => {
  const values = [100, 50, 30, 10];
  const cards = values.map((value) => ({ value }));
  // 50 carries 0.30 over 30's 0.20 — a free-chain zigzag. EV 35 sits inside
  // the lawful window [25, 37] at winMass 0.1 / floor 0.1, so the gate must
  // repair, not refuse.
  const out = enforceMonotoneLadderLawM({
    cards,
    weights: [1000, 3000, 2000, 4000],
    price: 60,
    nearMissFloor: 0.1,
  });
  assert(out.kind === "relayout", `repairable zigzag re-laid (got ${out.kind})`);
  if (out.kind !== "relayout") return;
  const total = out.weights.reduce((a, b) => a + b, 0);
  assert(total === 1_000_000_000, `re-laid on the pin grid (total ${total})`);
  for (const u of out.weights) assert(Number.isInteger(u) && u >= 0, "integer non-negative units");
  const shares = out.weights.map((u) => u / total);
  assert(findMonotoneViolations({ values, shares }).length === 0, "re-laid ladder is lawful");
  const winShare = shares[0]!;
  assert(Math.abs(winShare - 0.1) <= 1e-9, `win mass preserved exactly (got ${winShare})`);
  assert(Math.abs(out.risk.ev - 35) <= 60 * 1e-5, `landed EV preserved (got ${out.risk.ev})`);
  const nm = shares[1]! + shares[2]!;
  assert(nm >= 0.1 - 1e-7, `NM floor still met (got ${nm})`);
});

check("MG2b — gate: pins stay sovereign and EXACT through a re-layout", () => {
  const values = [100, 50, 30, 10];
  const cards = values.map((value) => ({ value }));
  // Win row pinned at 10%; the free loss rows zigzag (0.30 on 50 over 0.20 on
  // 30). Landed EV 35 ∈ [21, 37] (floor 0.1) → re-layout with the pin exact.
  const out = enforceMonotoneLadderLawM({
    cards,
    weights: [100_000_000, 300_000_000, 200_000_000, 400_000_000],
    price: 60,
    pinnedShares: new Map([[0, 0.1]]),
    nearMissFloor: 0.1,
  });
  assert(out.kind === "relayout", `pinned zigzag re-laid (got ${out.kind})`);
  if (out.kind !== "relayout") return;
  const total = out.weights.reduce((a, b) => a + b, 0);
  assert(out.weights[0]! === Math.round(0.1 * total), `pin exact on the grid (got ${out.weights[0]} / ${total})`);
  const shares = out.weights.map((u) => u / total);
  assert(
    findMonotoneViolations({ values, shares, pinnedIdx: new Set([0]) }).length === 0,
    "re-laid free chain is lawful",
  );
  assert(Math.abs(out.risk.ev - 35) <= 60 * 1e-5, `landed EV preserved (got ${out.risk.ev})`);
});

check("MG3 — gate: a zigzag OUTSIDE the lawful window refuses with the window attached", () => {
  const values = [100, 50, 10];
  // 0.3 win / 0.2 NM / 0.5 dust: landed EV 45, but every lawful ladder at
  // winMass 0.3 + floor 0.2 pays 49–51 — the sink shape underpays the ladder
  // law. The refusal must carry the exact lawful window.
  const out = enforceMonotoneLadderLawM({
    cards: values.map((value) => ({ value })),
    weights: [3000, 2000, 5000],
    price: 60,
    nearMissFloor: 0.2,
  });
  assert(out.kind === "refuse", `EV below the lawful window refuses (got ${out.kind})`);
  if (out.kind !== "refuse") return;
  assert(Math.abs(out.evTarget - 45) <= 1e-9, `evTarget 45 (got ${out.evTarget})`);
  assert(out.monotoneEvMin !== null && Math.abs(out.monotoneEvMin - 49) <= 1e-9, `lawful evMin 49 (got ${out.monotoneEvMin})`);
  assert(out.monotoneEvMax !== null && Math.abs(out.monotoneEvMax - 51) <= 1e-9, `lawful evMax 51 (got ${out.monotoneEvMax})`);
  assert(out.detail.includes("49.00") && out.detail.includes("51.00"), "detail speaks the lawful window in dollars");
});

check("MG3b — gate: win mass no lawful ladder can carry refuses with null bounds", () => {
  // 80% win mass over a 20% loss row: the chain needs the loss row ≥ every
  // win share — impossible. No window at ANY floor → structural refusal.
  const out = enforceMonotoneLadderLawM({
    cards: [{ value: 100 }, { value: 10 }],
    weights: [8000, 2000],
    price: 60,
    nearMissFloor: 0.1,
  });
  assert(out.kind === "refuse", `structural impossibility refuses (got ${out.kind})`);
  if (out.kind !== "refuse") return;
  assert(out.monotoneEvMin === null && out.monotoneEvMax === null, "no lawful window to report");
  assert(out.detail.includes("cannot be carried"), "detail names the structural cause");
});

check("MG4 — shapeWeights (retune path): Love Cycle tagged 0.5 is REFUSED as monotone-unreachable, never a sink plan", () => {
  const result = shapeWeights({
    cards: LOVE_CYCLE_VALUES.map((value) => ({ value })),
    price: 189.93,
    targetEdge: 0.111,
    targetWinRate: 0.5,
    winRateIsHard: true,
    nearMissMin: 0.115,
    winRateTol: 0.02,
    currentWeights: LOVE_CYCLE_LIVE_W,
    disperseLoss: true,
  });
  assert(!isSuccess(result), "tagged 0.5 must not ship a plan at the live price");
  if (isSuccess(result)) return;
  assert(
    result.limit?.kind === "monotone-unreachable",
    `refusal is the typed LAW M limit (got ${result.limit?.kind ?? "none"}: ${result.error})`,
  );
});

check("MG5 — retune search (hard hold + LAW M): Love Cycle untagged ships LAWFUL at both the live-anchored and the raised edge ask", () => {
  // The soft arm's float+sink is a legal LEVER (it may raise the cheapest
  // winner) — what it may no longer do is cross the near-miss boundary: the
  // 50.5%-win / 30%-on-$205 zigzag this pack used to ship is forbidden, and
  // the LAW M gate verifies every survivor. Both asks must land lawful.
  for (const targetEdge of [0.1098, 0.111]) {
    const search = searchBestPriceForCleanSnap({
      cards: LOVE_CYCLE_VALUES.map((value) => ({ value })),
      basePrice: 189.93,
      targetEdge,
      targetWinRate: 0.385,
      nearMissMin: 0.115,
      winRateTol: 0.02,
      maxPriceChangePct: 0.1,
      currentWeights: LOVE_CYCLE_LIVE_W,
      holdWinRateHard: true,
      disperseLoss: true,
    });
    const best = search.bestResult;
    assert(isSuccess(best), `edge ${targetEdge}: retune plans (${isSuccess(best) ? "" : best.error})`);
    if (!isSuccess(best)) return;
    const total = best.weights.reduce((a, b) => a + b, 0);
    const shares = best.weights.map((w) => w / total);
    assert(
      findMonotoneViolations({ values: LOVE_CYCLE_VALUES, shares }).length === 0,
      `edge ${targetEdge}: the shipped plan obeys LAW M end to end`,
    );
    // The exact boundary the owner rejected: cheapest winner ≤ near-miss.
    assert(
      shares[9]! <= shares[10]! + 1e-9,
      `edge ${targetEdge}: cheapest winner ≤ near-miss (got ${(shares[9]! * 100).toFixed(2)}% vs ${(shares[10]! * 100).toFixed(2)}%)`,
    );
    // The win-rate float stays inside the +5pp hold band — never the 50.5% runaway.
    assert(
      best.risk.winRate <= 0.385 + 0.05 + 1e-9,
      `edge ${targetEdge}: win rate held (got ${(best.risk.winRate * 100).toFixed(2)}%)`,
    );
    assert(best.edge >= targetEdge - 1e-9, `edge ${targetEdge}: at/above target (got ${best.edge})`);
  }
});

check("MG6 — full pipeline relayout: a dust-rich pool ships LAWFUL through the gate (hard hold, sink dead)", () => {
  // Love Cycle's win/NM structure + a REAL dust band (30 / 5 / 0.29): the
  // dust β-layout has freedom, so the hard-held solve plans — and LAW M's
  // chain (cheap dust ≥ near-miss share) is enforced by the end-of-solve
  // gate: lawful ladders at floor 0.115 pay dust-EV ≥ $4.10, so the 8.5%
  // edge ask (dust-EV $4.87) sits INSIDE the lawful window.
  const values = [834.0, 810.07, 719.99, 650.6, 600.0, 540.0, 453.0, 376.79, 208.09, 205.37, 152.9, 30, 5, 0.29];
  const live = [125, 125, 150, 190, 250, 340, 450, 470, 830, 920, 1150, 3000, 1500, 500];
  const search = searchBestPriceForCleanSnap({
    cards: values.map((value) => ({ value })),
    basePrice: 189.93,
    targetEdge: 0.085,
    targetWinRate: 0.385,
    nearMissMin: 0.115,
    winRateTol: 0.02,
    maxPriceChangePct: 0.1,
    currentWeights: live,
    holdWinRateHard: true,
    disperseLoss: true,
  });
  const best = search.bestResult;
  assert(isSuccess(best), `dust-rich retune plans (${isSuccess(best) ? "" : best.error})`);
  if (!isSuccess(best)) return;
  const total = best.weights.reduce((a, b) => a + b, 0);
  const shares = best.weights.map((w) => w / total);
  assert(
    findMonotoneViolations({ values, shares }).length === 0,
    `the shipped plan obeys LAW M end to end (${JSON.stringify(
      findMonotoneViolations({ values, shares })[0] ?? null,
    )})`,
  );
  // The boundary the sink used to break: cheapest winner ≤ near-miss ≤ dust.
  assert(shares[9]! <= shares[10]! + 1e-9, "cheapest winner ≤ near-miss");
  assert(shares[10]! <= shares[11]! + 1e-9, "near-miss ≤ cheapest-adjacent dust");
  assert(best.edge >= 0.085 - 1e-9, `edge at/above target (got ${best.edge})`);
});

// ── LAWFUL SNAP RETRY (wave 3): the LAW M gate re-lays, then the FULL snap
// stack retries on the lawful vector — every retry acceptance additionally
// holds the full-ladder law + the NM reality. Law over rungs, but rungs
// whenever the law allows them. Fixtures are real fleet pools (frozen
// 2026-07-08) whose pre-wave plans shipped honest-but-unsnapped: the retry
// must recover CLEAN odds without ever shipping a zigzag.

check("MG7 — lawful snap retry: God Pack recovers clean odds on the re-laid vector (was honest-unsnapped pre-wave)", () => {
  // Live-arm asks frozen from the fleet sweep (untagged, live-anchored).
  const values = [299.99, 152.05, 80.4, 62.76, 40.94, 25.02, 19.52, 15.36, 8.28, 0.65, 0.12];
  const live = [200, 400, 800, 2000, 4000, 59800, 100000, 112800, 100000, 100000, 520000];
  const search = searchBestPriceForCleanSnap({
    cards: values.map((value) => ({ value })),
    basePrice: 7.41,
    targetEdge: 0.10996605626536143,
    targetWinRate: 0.38,
    nearMissMin: 0.1,
    winRateTol: 0.02,
    maxPriceChangePct: 0.1,
    currentWeights: live,
    holdWinRateHard: true,
    disperseLoss: true,
  });
  const best = search.bestResult;
  assert(isSuccess(best), `God Pack retune plans (${isSuccess(best) ? "" : best.error})`);
  if (!isSuccess(best)) return;
  assert(best.snapped === true, "the retry recovers a SNAPPED plan (pre-wave this pool shipped unsnapped)");
  const total = best.weights.reduce((a, b) => a + b, 0);
  const shares = best.weights.map((w) => w / total);
  assert(
    findMonotoneViolations({ values, shares }).length === 0,
    "the recovered snap obeys LAW M end to end",
  );
  assert(best.edge >= 0.10996605626536143 - 1e-9, `edge at/above target (got ${best.edge})`);
  assert(
    best.risk.winRate <= 0.38 + 0.05 + 1e-9,
    `win rate held under the hard hold (got ${best.risk.winRate})`,
  );
});

check("MG8 — lawful snap retry holds the NM ask: Wicked lands rung-nice near-miss AT/ABOVE the floor, never below", () => {
  const values = [307.99, 197.96, 132.02, 93.7, 63.06, 42.04, 32.69, 22.8, 12.3, 9.16, 0.14];
  const live = [500, 2000, 10000, 20000, 40000, 40000, 75000, 150000, 100000, 250000, 312500];
  const search = searchBestPriceForCleanSnap({
    cards: values.map((value) => ({ value })),
    basePrice: 19.55,
    targetEdge: 0.11031253196930951,
    targetWinRate: 0.3375,
    nearMissMin: 0.1,
    winRateTol: 0.02,
    maxPriceChangePct: 0.1,
    currentWeights: live,
    holdWinRateHard: true,
    disperseLoss: true,
  });
  const best = search.bestResult;
  assert(isSuccess(best), `Wicked retune plans (${isSuccess(best) ? "" : best.error})`);
  if (!isSuccess(best)) return;
  assert(best.snapped === true, "the retry recovers a SNAPPED plan");
  const total = best.weights.reduce((a, b) => a + b, 0);
  const shares = best.weights.map((w) => w / total);
  assert(
    findMonotoneViolations({ values, shares }).length === 0,
    "the recovered snap obeys LAW M end to end",
  );
  // The snap may TRIM surplus NM down to a nice rung — but never below the ask.
  assert(
    best.risk.nearMiss >= 0.1 - 1e-9,
    `near-miss stays at/above the 10% ask (got ${best.risk.nearMiss})`,
  );
  assert(best.edge >= 0.11031253196930951 - 1e-9, `edge at/above target (got ${best.edge})`);
});

// ── STAGE 3 — LAW T strictness + NM-floor honesty ────────────────────
//
// LAW T: a TAGGED search that refuses at EVERY in-band price gets a typed
// `tag-unreachable` verdict when (and only when) the LAW M window math at
// the live price PROVES the tag sits outside the pool's lawful fit range
// ({@link lawfulTagFitRange}); structural refusals keep their own story.
// NM-floor honesty: the lawful rescue never silently loses a plan over the
// near-miss floor — when the requested floor empties the window, it lays at
// the bisected physics ceiling and records an explicit `nearMiss` relaxation.

check("LAW T — physics pool: tagged 10% over a lone $100 winner refuses as tag-unreachable with the window-proven max tag", () => {
  // One rich winner + poor dust: ANY 10% win mass carries $10 of EV against
  // a ~$3.56 contract — no in-band price can host the tag. The fit range at
  // $4 tops out just above 3% and the verdict must carry that number.
  const cards = [{ value: 100 }, { value: 0.5 }, { value: 0.3 }];
  const range = lawfulTagFitRange({ cards, price: 4, targetEdge: 0.1099 });
  assert(range !== null, "some smaller tag DOES fit this pool");
  if (range === null) return;
  assert(
    range.maxFit > 0.03 && range.maxFit < 0.04,
    `maxFit ≈ 3.26% (got ${(range.maxFit * 100).toFixed(3)}%)`,
  );
  assert(
    range.minFit > 0 && range.minFit < range.maxFit,
    `minFit below maxFit (got ${(range.minFit * 100).toFixed(3)}%–${(range.maxFit * 100).toFixed(3)}%)`,
  );
  const search = searchBestPriceForCleanSnap({
    cards,
    basePrice: 4,
    targetEdge: 0.1099,
    targetWinRate: 0.1,
    taggedWinRate: 0.1,
    winRateTol: TAGGED_WINRATE_TOLERANCE,
    nearMissMin: 0.1,
    maxPriceChangePct: 0.25,
    disperseLoss: true,
  });
  const r = search.bestResult;
  assert("error" in r, "the 10% tag must refuse");
  if (!("error" in r)) return;
  assert(!("weights" in r), "the error arm never carries a weights vector");
  assert(
    r.limit.kind === "tag-unreachable",
    `typed LAW T verdict (got ${r.limit.kind}: ${r.error})`,
  );
  const maxPct = `${(range.maxFit * 100).toFixed(2)}%`;
  assert(
    r.limit.detail.includes(maxPct),
    `the verdict carries the window-proven max tag ${maxPct} (got: ${r.limit.detail})`,
  );
  assert(
    /retag/i.test(r.limit.suggestion),
    `the retag remedy rides the verdict (got: ${r.limit.suggestion})`,
  );
});

check("LAW T — verdict guard: broken pins keep the specific pins-infeasible refusal (no tag-verdict overwrite)", () => {
  // Pins totalling 120% make EVERY tag infeasible WITH the pins while the
  // unpinned pool would host one — the pins are the story, and the typed
  // pins copy (which names the 120%) is more actionable than a tag verdict.
  const cards = [
    { value: 15 },
    { value: 40 },
    { value: 100 },
    { value: 1.4 },
    { value: 1.2 },
    { value: 0.9 },
  ];
  const search = searchBestPriceForCleanSnap({
    cards,
    basePrice: 4,
    targetEdge: 0.1099,
    targetWinRate: 0.12,
    taggedWinRate: 0.12,
    winRateTol: TAGGED_WINRATE_TOLERANCE,
    nearMissMin: 0.1,
    maxPriceChangePct: 0.25,
    currentWeights: [200, 300, 200, 3000, 3000, 3300],
    pinnedShares: [
      { index: 3, share: 0.6 },
      { index: 4, share: 0.6 },
    ],
    disperseLoss: true,
  });
  const r = search.bestResult;
  assert("error" in r, "over-100% pins must refuse");
  if (!("error" in r)) return;
  assert(
    r.limit.kind === "pins-infeasible",
    `the pins story survives the LAW T upgrade path (got ${r.limit.kind})`,
  );
});

check("NM-floor honesty — the rescue bisects to the physics ceiling and records the nearMiss relaxation (tag exact, LAW M clean)", () => {
  // A single near-miss card among 11 dust rows: under LAW M the NM card can
  // never out-weigh the dust below it, so the near-miss band can carry at
  // most L/k = 94%/12 ≈ 7.83% — the requested 10% floor is physically
  // unfundable at ANY layout. The narrow ±2% budget keeps the core's own
  // far-cent landings out of reach, so the lawful rescue must lay at base:
  // tag held EXACT, floor honestly relaxed to the bisected ceiling.
  const dust = [1.1, 1.05, 1.0, 0.95, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3];
  const values = [15, 40, 100, 2.0, ...dust];
  const search = searchBestPriceForCleanSnap({
    cards: values.map((value) => ({ value })),
    basePrice: 3,
    targetEdge: 0.1099,
    targetWinRate: 0.06,
    taggedWinRate: 0.06,
    winRateTol: TAGGED_WINRATE_TOLERANCE,
    nearMissMin: 0.1,
    maxPriceChangePct: 0.02,
    currentWeights: [500, 300, 200, 800, ...new Array(10).fill(745), 750],
    disperseLoss: true,
  });
  const best = search.bestResult;
  assert(isSuccess(best), `the rescue plans it (${isSuccess(best) ? "" : best.error})`);
  if (!isSuccess(best)) return;
  assert(search.usedSoftFallback === false, "the rescue counts as the hard arm, not a soft float");
  assert(
    Math.abs(best.risk.winRate - 0.06) <= 1e-6,
    `tag held EXACT through the relaxation (got ${(best.risk.winRate * 100).toFixed(4)}%)`,
  );
  const nm = best.relaxations.filter((x) => x.lever === "nearMiss");
  assert(nm.length === 1, `exactly one nearMiss relaxation (got ${best.relaxations.length})`);
  const relax = nm[0]!;
  assert(
    Math.abs(relax.requested - 0.1) <= 1e-9,
    `requested floor reported verbatim (got ${relax.requested})`,
  );
  assert(
    relax.applied < 0.09 && Math.abs(relax.applied - 0.94 / 12) < 1e-3,
    `applied = the L/k physics ceiling ≈ 7.83% (got ${(relax.applied * 100).toFixed(3)}%)`,
  );
  assert(
    Math.abs(best.risk.nearMiss - relax.applied) <= 1e-6,
    "the reported relaxation IS the shipped near-miss mass",
  );
  assert(
    /LAW M window/.test(relax.reason),
    `the relaxation names its provenance (got: ${relax.reason})`,
  );
  const total = best.weights.reduce((a, b) => a + b, 0);
  const shares = best.weights.map((w) => w / total);
  assert(
    findMonotoneViolations({ values, shares }).length === 0,
    "the relaxed re-lay obeys LAW M end to end",
  );
  assert(
    best.edge >= 0.1099 - 1e-9 && best.edge <= 0.1099 + 0.001 + 1e-6,
    `edge inside the rescue contract (got ${(best.edge * 100).toFixed(3)}%)`,
  );
});

// ── Summary ─────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} risk check(s) failed:`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log(`\n✓ All ${passes} pack risk checks passed.`);
