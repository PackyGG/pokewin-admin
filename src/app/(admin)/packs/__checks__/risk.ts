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
  TARGET_PACK_EDGE,
  DEFAULT_TARGET_WIN_RATE,
  DEFAULT_NEAR_MISS_MIN,
} from "../../../(pack-studio)/pack-studio/_lib/auto-targets";

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

check("shapeWeights: error arm never carries a weights vector", () => {
  // No win/grail cards → infeasible.
  const r1 = shapeWeights({ cards: [{ value: 1 }, { value: 2 }], price: 10, targetWinRate: 0.2 });
  assert(!isSuccess(r1), "no-win pool should error");
  assert(!("weights" in r1), "error must not carry weights");
  // targetWinRate + nearMissMin ≥ 1 → infeasible.
  const r2 = shapeWeights({
    cards: [{ value: 1 }, { value: 20 }],
    price: 10,
    targetWinRate: 0.95,
    nearMissMin: 0.1,
  });
  assert(!isSuccess(r2), "no-dust-mass should error");
  assert(!("weights" in r2), "error must not carry weights");
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
                  assert(
                    recomputed.edge >= targetEdge - 1e-9,
                    `edge≥target (p=${price},k=${kind},n=${n},e=${targetEdge}): ${recomputed.edge}`,
                  );
                  assert(
                    recomputed.edge - targetEdge <= 0.001 + 1e-9,
                    `edge−target≤0.001 (p=${price},k=${kind},n=${n},e=${targetEdge}): ${recomputed.edge - targetEdge}`,
                  );
                  assert(
                    Math.abs(recomputed.winRate - targetWinRate) <= 0.02 + 1e-9,
                    `winRate within tol (p=${price},k=${kind},n=${n},wr=${targetWinRate}): ${recomputed.winRate}`,
                  );
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
                  if (floor !== undefined) {
                    assert(
                      recomputed.floorRatio >= floor - 1e-9,
                      `floor met (p=${price},k=${kind},n=${n}): ${recomputed.floorRatio} < ${floor}`,
                    );
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

// ── 9. autoRetuneTargets wires the auto-cap + house defaults ────────────
check("autoRetuneTargets = {house edge, default win-rate/near-miss, autoMaxWinCap}", () => {
  const cfg = { globalCap: 25000, maxMultCeiling: 100 };
  for (const price of [1, 5, 25, 100, 1000]) {
    const t = autoRetuneTargets(price, cfg);
    approx(t.targetEdge, TARGET_PACK_EDGE, 1e-12, "targetEdge = house edge");
    approx(t.targetEdge, TARGET_HOUSE_EDGE, 1e-12, "house edge identity");
    approx(t.targetWinRate, DEFAULT_TARGET_WIN_RATE, 1e-12, "targetWinRate default");
    approx(t.nearMissMin, DEFAULT_NEAR_MISS_MIN, 1e-12, "nearMissMin default");
    approx(t.maxWinCap, autoMaxWinCap(price, cfg), 1e-9, "maxWinCap = autoMaxWinCap");
    assert(t.maxWinCap >= price - 1e-9, `auto cap ≥ price (p=${price})`);
  }
});

// ── Summary ─────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} risk check(s) failed:`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log(`\n✓ All ${passes} pack risk checks passed.`);
