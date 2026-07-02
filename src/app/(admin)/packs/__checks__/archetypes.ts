/**
 * Retune V2 ARCHETYPE + GUIDANCE ruleset harness.
 *
 * Run with:
 *   npx tsx "src/app/(admin)/packs/__checks__/archetypes.ts"
 *
 * NO DB, NO React, NO server imports — pins every rule the tag/archetype
 * ruleset (2026-07-03) put into code, one check per rule:
 *
 *   1.  Archetype targets: tagged → nearMissMin 0 (TAGGED_NEAR_MISS_MIN);
 *       untagged → the 0.1 default; untagged target set byte-identical golden.
 *   2.  CAP-STRIP fix: tagged caps carry TAG_CAP_HEADROOM (1% → 2300×p,
 *       5% → 460×p, 10% → 230×p) so deliberately-run 202–207× 10% jackpots
 *       survive; untagged cap byte-identical (100×, no headroom).
 *   3.  Arbitrary hit-rates (TAG-TRUTH): name-parse decimals (4.9%, 0.2%),
 *       DB-tag arbitrary notation (%4.9 / pct0.2), the (0, 0.5] clamp, and
 *       the DB-first detailed resolver with the mislabel conflict flag.
 *   4.  LAW 6 (new-card anchor exemption): a staged-in win card (current
 *       weight 0) enters UNCAPPED and flips a saturated need-ev-up pool from
 *       error to a tag-exact solve; a NEW grail stays clamped at the
 *       next-cheaper EXISTING grail's odds; existing cards' caps unchanged.
 *   5.  One-sided-up acceptance: a saturated pool with 0.20pp edge excess
 *       SOLVES (edge above target, tag exact, excess reported); 0.30pp still
 *       errors — and its guidance carries a price fix as suggestions[0].
 *   6.  LAW 15: tagged solves hold |winRate − tag| ≤ 1e-4 (the 1% → 1.072%
 *       snap drift is unconstructible).
 *   7.  Add-dust round-trip (LAW 4): 0.95·v_b flips error → success with the
 *       tag exactly held; 1.05·v_b still fails; a $0.01-only-dust pool marks
 *       add-dust impossible (no add-card suggestion) but still gets a price
 *       fix — or an explicit no-fix-under-constraints when the price is
 *       pinned. Analytic expected-share matches the solver's landed share.
 *   8.  Tagged per-100k snap (CLEAN-XOR-TAG fix): a snapped tagged result is
 *       an integer per-100k ladder, win-band sum EXACTLY round(t·1e5), total
 *       exactly 100000, dust buffer carries the residual.
 *   9.  Near-miss seeding: nearMissMin 0 keeps NM cards at ~zero mass (dead
 *       for the tag), never a relaxation-noise error.
 *   10. Suggestion honesty: every ranked suggestion's proof.feasibleAfter is
 *       true; infeasible guidance NEVER comes back bare (≥ 1 suggestion or an
 *       explicit no-fix-under-constraints).
 *   11. Perf: full guidance ≪ 10 ms/pack.
 *   12. UNTAGGED degenerate loss ladder (the owner-found "Captive" case):
 *       the plan reproduces (price moves down, two loss cards pinned at the
 *       0.0001% quantization floor, win-rate floats to ~29.3%), the
 *       degenerate detection fires, add-card emits a near-miss band inside
 *       [242.75, 485.50) + a solver-verified fix price, remove-dead-card
 *       lists exactly the two pinned cards, accept-as-is carries the WHY —
 *       and the enriched pool (one ~$300 mid card at the fix price) plans
 *       with NO floor-pinned cards and the win rate back at ~20%. A healthy
 *       untagged plan returns NO guidance.
 *
 * Exit code 0 = all passed; 1 = at least one failure (printed).
 */

import {
  DEFAULT_NEAR_MISS_MIN,
  DEFAULT_TARGET_WIN_RATE,
  TAGGED_NEAR_MISS_MIN,
  TAG_CAP_HEADROOM,
  autoMaxWinCap,
  autoRetuneTargets,
  autoTargetEdge,
  hitRateFromTags,
  parsePackHitRate,
  resolveIntendedHitRate,
  resolveIntendedHitRateDetailed,
  DEFAULT_EDGE_CURVE,
} from "../_lib/auto-targets";
import {
  ONE_SIDED_EDGE_EXCESS_TOL,
  TAGGED_WINRATE_TOLERANCE,
  searchBestPriceForCleanSnap,
  shapeWeights,
  waterFillBandProbs,
  type ShapeWeightsSuccess,
  type ShapeWeightsResult,
} from "../../insights/edge-calc/risk";
import {
  computeTagGuidance,
  computeUntaggedGuidance,
  isFloorPinnedPct,
} from "../../insights/edge-calc/tag-guidance";
import { buildRetuneSearchParams } from "../_lib/retune-params";

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

function approx(got: number, want: number, tol: number, label: string): void {
  assert(
    Number.isFinite(got) && Math.abs(got - want) <= tol,
    `${label}: expected ≈${want} (±${tol}), got ${got}`,
  );
}

function isSuccess(r: ShapeWeightsResult): r is ShapeWeightsSuccess {
  return "weights" in r;
}

const CFG = { globalCap: 25000, maxMultCeiling: 100 };

// ── 1. Archetype targets ────────────────────────────────────────────────
check("archetype targets: tagged nearMissMin = 0 (seeded upward by callers); untagged = 0.1", () => {
  assert(TAGGED_NEAR_MISS_MIN === 0, "TAGGED_NEAR_MISS_MIN must be 0 (binary lottery genre)");
  for (const name of ["1% 18 PLUS", "5% Blazing Light", "10% Divine Order"]) {
    const t = autoRetuneTargets(12, CFG, name);
    approx(t.nearMissMin, 0, 1e-12, `${name} → nearMissMin 0`);
  }
  const un = autoRetuneTargets(12, CFG, "Supreme");
  approx(un.nearMissMin, DEFAULT_NEAR_MISS_MIN, 1e-12, "untagged → 0.1");
});

check("archetype targets: untagged target set is the byte-identical golden", () => {
  for (const price of [0.5, 2, 12.5, 99, 766]) {
    const t = autoRetuneTargets(price, CFG);
    const cap = Math.max(Math.min(CFG.globalCap, price * CFG.maxMultCeiling), price);
    approx(t.maxWinCap, cap, 1e-9, `untagged $${price} cap = min(global, 100×p)`);
    approx(t.targetWinRate, DEFAULT_TARGET_WIN_RATE, 1e-12, "untagged win-rate 0.20");
    approx(t.nearMissMin, DEFAULT_NEAR_MISS_MIN, 1e-12, "untagged near-miss 0.1");
    approx(
      t.targetEdge,
      autoTargetEdge({ price, maxWin: cap }, DEFAULT_EDGE_CURVE),
      1e-12,
      "untagged edge = curve(price, cap)",
    );
  }
});

check("pool-aware curve input: poolMaxWin lowers the premium, never below the floor, legacy identical", () => {
  // A 1% pack whose loosened cap is $2875 but whose ACTUAL top card is $810:
  // the curve must price the real exposure, not the theoretical cap.
  const capProxy = autoRetuneTargets(1.25, CFG, "1% 18 PLUS");
  const poolAware = autoRetuneTargets(1.25, CFG, "1% 18 PLUS", 810.07);
  assert(
    poolAware.targetEdge <= capProxy.targetEdge + 1e-12,
    "pool-aware target never exceeds the cap-proxy target",
  );
  approx(
    poolAware.targetEdge,
    autoTargetEdge({ price: 1.25, maxWin: 810.07 }, DEFAULT_EDGE_CURVE),
    1e-12,
    "pool-aware target = curve(price, actual top)",
  );
  // Omitted / non-positive poolMaxWin ⇒ legacy cap-proxy, byte-identical.
  approx(
    autoRetuneTargets(1.25, CFG, "1% 18 PLUS", null).targetEdge,
    capProxy.targetEdge,
    1e-15,
    "null poolMaxWin = legacy",
  );
  approx(
    autoRetuneTargets(1.25, CFG, "1% 18 PLUS", 0).targetEdge,
    capProxy.targetEdge,
    1e-15,
    "0 poolMaxWin = legacy",
  );
});

// ── 2. CAP-STRIP fix ────────────────────────────────────────────────────
check("tagged jackpot caps carry TAG_CAP_HEADROOM: 2300×/460×/230×; untagged byte-identical", () => {
  assert(Math.abs(TAG_CAP_HEADROOM - 1.15) < 1e-12, "headroom is 1.15");
  approx(autoMaxWinCap(1, CFG, 0.01), 2300, 1e-9, "1% → 2300×p");
  approx(autoMaxWinCap(1, CFG, 0.05), 460, 1e-9, "5% → 460×p");
  approx(autoMaxWinCap(1, CFG, 0.1), 230, 1e-9, "10% → 230×p");
  // The motivating prod cases: Bling Bling $2,400 @ $11.85 (202.5×) and
  // Chaos $905.83 @ $4.38 (206.8×) survive the pre-filter.
  assert(autoMaxWinCap(11.85, CFG, 0.1) >= 2400, "Bling Bling's jackpot survives");
  assert(autoMaxWinCap(4.38, CFG, 0.1) >= 905.83, "Chaos' jackpot survives");
  // Untagged / at-or-above-default hit-rates: NO headroom, byte-identical.
  approx(autoMaxWinCap(1, CFG), 100, 1e-9, "untagged → plain 100×");
  approx(autoMaxWinCap(1, CFG, 0.2), 100, 1e-9, "0.20 → plain 100×");
  approx(autoMaxWinCap(1, CFG, 0.5), 100, 1e-9, "0.50 → plain 100× (never tighter)");
  // The absolute global cap still clamps the loosened multiplier.
  approx(autoMaxWinCap(1000, CFG, 0.01), 25000, 1e-9, "globalCap clamp holds");
});

// ── 3. Arbitrary hit-rates (TAG-TRUTH) ──────────────────────────────────
check("arbitrary hit-rates: decimal name tags, arbitrary DB notation, (0,0.5] clamp, conflict flag", () => {
  approx(parsePackHitRate("4.9% Blazing Light")!, 0.049, 1e-12, "name 4.9%");
  approx(parsePackHitRate("0.2% Heavy Hitters")!, 0.002, 1e-12, "name 0.2%");
  approx(hitRateFromTags(["%4.9"])!, 0.049, 1e-12, "DB %4.9");
  approx(hitRateFromTags(["pct0.2"])!, 0.002, 1e-12, "DB pct0.2");
  approx(hitRateFromTags(["%30"])!, 0.3, 1e-12, "DB %30 (Divine Order retag)");
  // Product-tier map stays FIRST and byte-identical.
  approx(hitRateFromTags(["pct1"])!, 0.01, 1e-12, "pct1");
  approx(hitRateFromTags(["%10"])!, 0.1, 1e-12, "%10");
  // Clamp: a "tag" above 50% winners is not a lottery product.
  assert(hitRateFromTags(["%75"]) === null, "%75 rejected (> 0.5)");
  assert(hitRateFromTags(["%0"]) === null, "%0 rejected");
  // Unknown non-pct tags never resolve.
  assert(hitRateFromTags(["50/50", "onepiece"]) === null, "non-pct tags → null");

  // DB-first + conflict flag (the 4 silently-mis-labeled prod pools).
  const dbOnly = resolveIntendedHitRateDetailed("Heavy Hitters", ["%1"]);
  assert(dbOnly.hitRate === 0.01 && dbOnly.source === "db" && !dbOnly.conflict, "DB-only tag");
  const nameOnly = resolveIntendedHitRateDetailed("5% Frosty", []);
  assert(nameOnly.hitRate === 0.05 && nameOnly.source === "name" && !nameOnly.conflict, "name-only tag");
  const conflicted = resolveIntendedHitRateDetailed("10% Divine Order", ["%5"]);
  assert(
    conflicted.hitRate === 0.05 && conflicted.source === "db" && conflicted.conflict,
    "DB wins on disagreement AND the conflict is flagged",
  );
  assert(
    resolveIntendedHitRate("10% Divine Order", ["%5"]) === 0.05,
    "compact resolver stays DB-first",
  );
  const untagged = resolveIntendedHitRateDetailed("Supreme", []);
  assert(untagged.hitRate === null && untagged.source === null && !untagged.conflict, "untagged");
});

// ── 4. LAW 6 — new-card anchor exemption ────────────────────────────────
// Saturated need-ev-up pool: one winner pinned at 1% live odds under a 5%
// tag; every cent of the tag's payout has to come from somewhere the caps
// don't allow — a hard error today. Staging IN a $210 grail (weight 0) must
// flip it feasible: the new card is UNCAPPED and takes the spill mass.
const LAW6_BASE = {
  price: 10,
  targetEdge: 0.11,
  targetWinRate: 0.05,
  winRateTol: TAGGED_WINRATE_TOLERANCE,
  winRateIsHard: true as const,
  maxWinCap: 2300,
};

check("LAW 6: a staged-in win card (current weight 0) enters UNCAPPED and flips the solve feasible", () => {
  const without = shapeWeights({
    ...LAW6_BASE,
    cards: [{ value: 15 }, { value: 0.5 }, { value: 0.05 }],
    currentWeights: [100, 5000, 4900],
  });
  assert(!isSuccess(without), "control: without the new card the pool is infeasible");

  const withCard = shapeWeights({
    ...LAW6_BASE,
    cards: [{ value: 15 }, { value: 210 }, { value: 0.5 }, { value: 0.05 }],
    currentWeights: [100, 0, 5000, 4900], // $210 staged-in → 0 anchor → UNCAPPED
  });
  assert(isSuccess(withCard), `with the staged-in $210 card the pool must solve: ${!isSuccess(withCard) ? withCard.error : ""}`);
  approx(withCard.risk.winRate, 0.05, TAGGED_WINRATE_TOLERANCE + 1e-9, "tag exactly held");
  assert(withCard.risk.edge >= 0.11 - 1e-9, "edge ≥ target");
  // The EXISTING winner's never-inflate cap is untouched: its odds stay ≤ 1%.
  const total = withCard.weights.reduce((a, b) => a + b, 0);
  const oddsOf = (i: number): number => withCard.weights[i]! / total;
  assert(oddsOf(0) <= 0.01 + 1e-6, `existing $15 winner stays ≤ its live 1% (got ${(oddsOf(0) * 100).toFixed(4)}%)`);
  assert(oddsOf(1) > 0.02, `the new $210 card carries real mass (got ${(oddsOf(1) * 100).toFixed(4)}%)`);
});

check("LAW 6 bound: the water-fill respects existing caps; an uncapped new card takes the overflow; a clamped grail never exceeds the cheaper rung", () => {
  const values = [15, 60, 210];
  // $15 capped at its live 1%, $60 at its live 0.35%, $210 staged-in →
  // UNCAPPED (LAW 6 — a new card has no advertised odds to protect).
  const caps = [0.01, 0.0035, Infinity];
  const fill = waterFillBandProbs(values, caps, 0.05, 1.5);
  approx(fill.placed, 0.05, 1e-12, "full mass placed — no spill with an uncapped card in the pool");
  assert(fill.probs[0]! <= 0.01 + 1e-12, "existing $15 winner's never-inflate cap respected");
  assert(fill.probs[1]! <= 0.0035 + 1e-12, "existing $60 grail's never-inflate cap respected");
  approx(
    fill.probs[2]!,
    0.05 - fill.probs[0]! - fill.probs[1]!,
    1e-12,
    "the uncapped new card absorbs exactly the overflow",
  );
  // The grail monotone running-min (LAW 5's constraint): shapeWeights clamps
  // a NEW grail at the next-cheaper EXISTING grail's odds. With the tightened
  // cap in place the new card can never exceed the rung — and the fill
  // saturates (reported via `placed`, never a silent overshoot).
  const tightened = [0.01, 0.0035, 0.0035];
  const clamped = waterFillBandProbs(values, tightened, 0.05, 1.5);
  assert(
    clamped.probs[2]! <= 0.0035 + 1e-12,
    "clamped new grail never exceeds the cheaper grail's odds",
  );
  assert(clamped.placed < 0.05 - 1e-9, "the clamp saturates the fill (spill is reported, not hidden)");
});

// ── 5. One-sided-up acceptance ──────────────────────────────────────────
// Saturated single-winner pool pinned at a point EV: winner $170 @ 5% live
// (cap = tag ⇒ fully saturated), one dust card. Point EV = 0.05·170 +
// 0.95·v_dust; price $10, target 11%.
check("one-sided-up: 0.20pp excess SOLVES (edge above target, tag exact, excess reported)", () => {
  // v_dust 0.40 → E0 = 8.88 → achieved edge 11.20% vs target 11% → +0.20pp.
  const r = shapeWeights({
    price: 10,
    targetEdge: 0.11,
    targetWinRate: 0.05,
    winRateTol: TAGGED_WINRATE_TOLERANCE,
    cards: [{ value: 170 }, { value: 0.4 }],
    currentWeights: [500, 9500],
    maxWinCap: 2300,
    winRateIsHard: true,
  });
  assert(isSuccess(r), `0.20pp excess must be accepted: ${!isSuccess(r) ? r.error : ""}`);
  approx(r.risk.winRate, 0.05, TAGGED_WINRATE_TOLERANCE + 1e-9, "tag exact");
  assert(r.risk.edge >= 0.11 - 1e-9, "edge ≥ target");
  assert(r.risk.edge <= 0.11 + ONE_SIDED_EDGE_EXCESS_TOL + 1e-6, "edge ≤ target + 0.25pp");
  assert(
    typeof r.oneSidedEdgeExcess === "number" && r.oneSidedEdgeExcess > 0.0015 && r.oneSidedEdgeExcess < 0.0025,
    `oneSidedEdgeExcess reported (~0.002, got ${r.oneSidedEdgeExcess})`,
  );
  // §8's per-100k ladder lands here too (the tagged snap): integer grid,
  // win band EXACTLY round(t·1e5), total exactly 100000.
  assert(r.snapped === true, "tagged per-100k snap accepted");
  const total = r.weights.reduce((a, b) => a + b, 0);
  assert(total === 100_000, `per-100k ladder total exactly 100000 (got ${total})`);
  assert(
    r.weights.every((w) => Number.isInteger(w) && w >= 0),
    "all weights are integers",
  );
  approx(r.weights[0]!, Math.round(0.05 * 100_000), 0, "win band sum exactly round(t·1e5)");
});

check("one-sided-up: 0.30pp excess still ERRORS — and guidance ranks a price fix first", () => {
  // v_dust 0.4 and winner $169.8 → E0 = 8.87 → excess 0.30pp.
  const cards = [{ value: 169.8 }, { value: 0.4 }];
  const currentWeights = [500, 9500];
  const r = shapeWeights({
    price: 10,
    targetEdge: 0.11,
    targetWinRate: 0.05,
    winRateTol: TAGGED_WINRATE_TOLERANCE,
    cards,
    currentWeights,
    maxWinCap: 2300,
    winRateIsHard: true,
  });
  assert(!isSuccess(r), "0.30pp excess is beyond the acceptance — must error");

  const g = computeTagGuidance({
    cards,
    currentWeights,
    price: 10,
    targetEdge: 0.11,
    tag: 0.05,
    nearMissMin: 0,
    maxWinCap: 2300,
    cfg: CFG,
    liveWinRate: 0.05,
    liveNearMiss: 0,
  });
  assert(!g.feasibility.feasible, "guidance agrees: infeasible");
  assert(g.feasibility.saturated, "guidance detects saturation");
  assert(g.suggestions.length >= 1, "never a bare error");
  const top = g.suggestions[0]!;
  assert(
    top.kind === "price-move" || top.kind === "price-edge-exact",
    `price fix ranks first (got ${top.kind})`,
  );
  assert(top.proof.feasibleAfter === true, "top suggestion is proven");
  assert(top.proof.solverVerified === true, "top suggestion round-tripped the real solver");
  const pPrime = Number(top.params.price);
  assert(pPrime > 9.5 && pPrime < 10.5 && pPrime !== 10, `sane price fix near $10 (got $${pPrime})`);
});

// ── 6. LAW 15 — the 1% → 1.072% drift is unconstructible ────────────────
check("LAW 15: every accepted tagged solve holds |winRate − tag| ≤ 1e-4", () => {
  const pools: { cards: { value: number }[]; weights: number[]; price: number; tag: number }[] = [
    {
      // 1% lottery: one dust + a grail ladder (18-PLUS-shaped).
      cards: [
        { value: 810.07 }, { value: 508.45 }, { value: 118.21 }, { value: 75.47 },
        { value: 64.76 }, { value: 60.25 }, { value: 0.08 }, { value: 0.03 },
      ],
      weights: [1, 4, 45, 150, 300, 500, 74000, 25000],
      price: 1.25,
      tag: 0.01,
    },
    {
      // 5% two-winner pool with dust freedom.
      cards: [{ value: 170 }, { value: 60 }, { value: 3.8 }, { value: 0.4 }],
      weights: [200, 300, 5000, 4500],
      price: 10,
      tag: 0.05,
    },
  ];
  for (const p of pools) {
    const t = autoRetuneTargets(p.price, CFG, p.tag, Math.max(...p.cards.map((c) => c.value)));
    const r = shapeWeights({
      cards: p.cards,
      price: p.price,
      targetEdge: t.targetEdge,
      targetWinRate: p.tag,
      winRateTol: TAGGED_WINRATE_TOLERANCE,
      maxWinCap: t.maxWinCap,
      nearMissMin: 0,
      currentWeights: p.weights,
      winRateIsHard: true,
    });
    if (isSuccess(r)) {
      assert(
        Math.abs(r.risk.winRate - p.tag) <= TAGGED_WINRATE_TOLERANCE + 1e-9,
        `accepted solve holds the tag to 0.01pp (got ${(r.risk.winRate * 100).toFixed(4)}% vs ${(p.tag * 100).toFixed(2)}%)`,
      );
    }
    // An error is acceptable here (some fixtures are deliberately tight) —
    // the pin is that NO accepted result may drift the tag.
  }
});

// ── 7. Add-dust round-trip (LAW 4) ──────────────────────────────────────
// Saturated need-ev-down pool: winner $170 @ 5% (point win EV 8.5), single
// $2 dust ⇒ E0 = 10.4 > E* = 8.9. v_b = (E* − W − 0)/d = 0.4/0.95 ≈ 0.4211.
const DUST_FIXTURE = {
  price: 10,
  targetEdge: 0.11,
  tag: 0.05,
  cards: [{ value: 170 }, { value: 2 }],
  currentWeights: [500, 9500],
};

check("LAW 4: 0.95·v_b flips error → success (tag exact); 1.05·v_b still fails", () => {
  const vB = (10 * (1 - 0.11) - 0.05 * 170) / 0.95;
  approx(vB, 0.42105, 1e-4, "v_b analytic");
  const solveWith = (extra: number | null): ShapeWeightsResult =>
    shapeWeights({
      price: DUST_FIXTURE.price,
      targetEdge: DUST_FIXTURE.targetEdge,
      targetWinRate: DUST_FIXTURE.tag,
      winRateTol: TAGGED_WINRATE_TOLERANCE,
      cards: extra === null ? DUST_FIXTURE.cards : [...DUST_FIXTURE.cards, { value: extra }],
      currentWeights:
        extra === null
          ? DUST_FIXTURE.currentWeights
          : [...DUST_FIXTURE.currentWeights, 0],
      maxWinCap: 2300,
      winRateIsHard: true,
    });
  assert(!isSuccess(solveWith(null)), "control: no added card ⇒ infeasible");
  const good = solveWith(Math.round(0.95 * vB * 100) / 100);
  assert(isSuccess(good), `0.95·v_b must solve: ${!isSuccess(good) ? good.error : ""}`);
  approx(good.risk.winRate, 0.05, TAGGED_WINRATE_TOLERANCE + 1e-9, "tag exactly held");
  const bad = solveWith(Math.round(1.05 * vB * 100) / 100);
  assert(!isSuccess(bad), "1.05·v_b must still fail (bound is tight)");
});

check("LAW 4 guidance: add-card carries the band + analytic share ≈ solver-landed share", () => {
  const g = computeTagGuidance({
    cards: DUST_FIXTURE.cards,
    currentWeights: DUST_FIXTURE.currentWeights,
    price: DUST_FIXTURE.price,
    targetEdge: DUST_FIXTURE.targetEdge,
    tag: DUST_FIXTURE.tag,
    nearMissMin: 0,
    maxWinCap: 2300,
    cfg: CFG,
    pinPrice: true, // isolate the pool lever
    liveWinRate: 0.05,
    liveNearMiss: 0,
  });
  assert(g.feasibility.direction === "need-ev-down", "direction: reachable EV above target");
  const add = g.suggestions.find((s) => s.kind === "add-card");
  assert(add !== undefined, "an add-card suggestion is emitted");
  const vMin = Number(add!.params.valueMin);
  const vMax = Number(add!.params.valueMax);
  const vSug = Number(add!.params.suggestedValue);
  assert(vMin === 0.01, "band floor $0.01");
  assert(vMax > 0.3 && vMax < 0.43, `band ceiling ≈ v_b (got ${vMax})`);
  assert(vSug >= vMin && vSug <= vMax, "suggested value inside the band");
  assert(add!.proof.feasibleAfter === true, "proven");

  // Analytic share vs the REAL solver's landed share for the new card.
  const analyticShare = Number(add!.params.expectedShare);
  const solved = shapeWeights({
    price: DUST_FIXTURE.price,
    targetEdge: DUST_FIXTURE.targetEdge,
    targetWinRate: DUST_FIXTURE.tag,
    winRateTol: TAGGED_WINRATE_TOLERANCE,
    cards: [...DUST_FIXTURE.cards, { value: vSug }],
    currentWeights: [...DUST_FIXTURE.currentWeights, 0],
    maxWinCap: 2300,
    winRateIsHard: true,
  });
  assert(isSuccess(solved), "suggested value solves");
  const total = solved.weights.reduce((a, b) => a + b, 0);
  const landed = solved.weights[2]! / total;
  approx(landed, analyticShare, 0.02, `landed share ≈ analytic (${(analyticShare * 100).toFixed(1)}%)`);
});

check("LAW 4 impossibility: $0.01-only dust ⇒ NO add-card; price fix or explicit no-fix", () => {
  // Winner $180 @ 5% ⇒ point win EV 9.0; dust $0.01 ⇒ E0 ≈ 9.01 > E* 8.9,
  // and no cheaper dust card can exist (cent floor).
  const cards = [{ value: 180 }, { value: 0.01 }];
  const currentWeights = [500, 9500];
  const base = {
    cards,
    currentWeights,
    price: 10,
    targetEdge: 0.11,
    tag: 0.05,
    nearMissMin: 0,
    maxWinCap: 2300,
    liveWinRate: 0.05,
    liveNearMiss: 0,
  };
  // Price allowed → the price lever covers it (no add-card emitted).
  const g1 = computeTagGuidance({ ...base, cfg: CFG });
  assert(!g1.feasibility.feasible, "infeasible at the current price");
  assert(g1.suggestions.every((s) => s.kind !== "add-card"), "add-dust marked impossible — never emitted");
  assert(
    g1.suggestions.some(
      (s) => (s.kind === "price-move" || s.kind === "price-edge-exact") && s.proof.feasibleAfter,
    ),
    "the price lever still rescues it",
  );
  // Price pinned → explicit no-fix, NEVER a bare empty list.
  const g2 = computeTagGuidance({ ...base, cfg: CFG, pinPrice: true });
  assert(g2.suggestions.length >= 1, "never bare");
  assert(
    g2.suggestions.some((s) => s.kind === "no-fix-under-constraints"),
    "explicit no-fix-under-constraints with the price pinned",
  );
});

// ── 9. Near-miss seeding ────────────────────────────────────────────────
check("near-miss 0: NM cards in a tagged pool get ~zero mass (dead), no noise relaxations", () => {
  // 5% pool carrying one NM-band card ($6 ∈ [5, 10)).
  const r = shapeWeights({
    price: 10,
    targetEdge: 0.11,
    targetWinRate: 0.05,
    winRateTol: TAGGED_WINRATE_TOLERANCE,
    cards: [{ value: 170 }, { value: 6 }, { value: 3.8 }, { value: 0.4 }],
    currentWeights: [500, 0, 5000, 4500],
    maxWinCap: 2300,
    nearMissMin: 0, // TAGGED_NEAR_MISS_MIN
    winRateIsHard: true,
  });
  assert(isSuccess(r), `expected success: ${!isSuccess(r) ? r.error : ""}`);
  const total = r.weights.reduce((a, b) => a + b, 0);
  const nmMass = r.weights[1]! / total;
  assert(nmMass <= 0.001 + 1e-9, `NM card carries ~zero mass (got ${(nmMass * 100).toFixed(4)}%)`);
  assert(
    !r.relaxations.some((x) => x.lever === "nearMiss"),
    "no near-miss relaxation noise at the 0 floor",
  );
  approx(r.risk.winRate, 0.05, TAGGED_WINRATE_TOLERANCE + 1e-9, "tag exact");
});

// ── 10. Suggestion honesty (global sweep over this file's guidance runs) ──
check("suggestion honesty: every ranked suggestion is proven; infeasible ⇒ never bare", () => {
  const scenarios: Parameters<typeof computeTagGuidance>[0][] = [
    {
      cards: [{ value: 169.8 }, { value: 0.4 }],
      currentWeights: [500, 9500],
      price: 10,
      targetEdge: 0.11,
      tag: 0.05,
      nearMissMin: 0,
      maxWinCap: 2300,
      cfg: CFG,
      liveWinRate: 0.05,
      liveNearMiss: 0,
    },
    {
      cards: DUST_FIXTURE.cards,
      currentWeights: DUST_FIXTURE.currentWeights,
      price: 10,
      targetEdge: 0.11,
      tag: 0.05,
      nearMissMin: 0,
      maxWinCap: 2300,
      cfg: CFG,
      liveWinRate: 0.05,
      liveNearMiss: 0,
    },
    {
      cards: [{ value: 180 }, { value: 0.01 }],
      currentWeights: [500, 9500],
      price: 10,
      targetEdge: 0.11,
      tag: 0.05,
      nearMissMin: 0,
      maxWinCap: 2300,
      cfg: CFG,
      pinPrice: true,
      liveWinRate: 0.05,
      liveNearMiss: 0,
    },
  ];
  for (const sc of scenarios) {
    const g = computeTagGuidance(sc);
    for (const s of g.suggestions) {
      if (s.kind === "remove-dead-card" || s.kind === "no-fix-under-constraints") continue;
      assert(
        s.proof.feasibleAfter === true,
        `ranked suggestion ${s.kind} must be proven (feasibleAfter)`,
      );
    }
    if (!g.feasibility.feasible) {
      assert(g.suggestions.length >= 1, "infeasible verdicts always carry ≥ 1 entry");
    }
  }
});

// ── 11. Perf ────────────────────────────────────────────────────────────
check("perf: full guidance well under 10 ms/pack", () => {
  const input: Parameters<typeof computeTagGuidance>[0] = {
    cards: [
      { value: 810.07 }, { value: 508.45 }, { value: 118.21 }, { value: 75.47 },
      { value: 64.76 }, { value: 60.25 }, { value: 0.08 }, { value: 0.03 },
    ],
    currentWeights: [1, 4, 45, 150, 300, 500, 74000, 25000],
    price: 1.25,
    targetEdge: 0.1099,
    tag: 0.01,
    nearMissMin: 0,
    maxWinCap: 2875,
    cfg: CFG,
    liveWinRate: 0.01,
    liveNearMiss: 0,
  };
  computeTagGuidance(input); // warm
  const N = 20;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) computeTagGuidance(input);
  const perPack = (performance.now() - t0) / N;
  assert(perPack < 10, `guidance must stay under 10 ms/pack (got ${perPack.toFixed(2)} ms)`);
  console.log(`      [guidance ≈ ${perPack.toFixed(2)} ms/pack]`);
});

// ── 12. UNTAGGED degenerate loss ladder — the owner-found "Captive" case ──
// Pack "Captive", $485.50, untagged. The plan is EV-forced: at the landed
// price the anchored win band delivers ≈$330.28 against an EV target of
// ≈$387.19, so the loss side must average ≈$80.50 over 70.7% of opens — only
// the $80.28 card can carry that, the $33.95 / $18.23 cards get pinned at the
// 0.0001% quantization floor, the near-miss band [242.75, 485.50) is EMPTY,
// and the win rate floats to 29.3% on the two cheapest winners. The owner
// asked WHY two cards sit at 0.0001% — the guidance must answer it itself.
const CAPTIVE = {
  price: 485.5,
  values: [9100, 3247.24, 2040, 1080, 635.14, 80.28, 33.95, 18.23],
  weights: [5000, 40000, 50000, 70000, 85000, 150000, 200000, 400000],
};
const CAPTIVE_IDS = CAPTIVE.values.map((v) => `captive-${v}`);
const captiveTargets = autoRetuneTargets(
  CAPTIVE.price,
  CFG,
  undefined,
  Math.max(...CAPTIVE.values),
);
// The EXACT solve path `planPackTune`'s live arm runs (shared param builder).
const captiveSearch = searchBestPriceForCleanSnap(
  buildRetuneSearchParams("live", {
    cards: CAPTIVE.values.map((v) => ({ value: v })),
    basePrice: CAPTIVE.price,
    targetEdge: captiveTargets.targetEdge,
    targetWinRate: captiveTargets.targetWinRate,
    maxWinCap: captiveTargets.maxWinCap,
    nearMissMin: captiveTargets.nearMissMin,
    winRateTol: 0.02,
    currentWeights: CAPTIVE.weights,
    intendedHitRate: null,
  }),
);
const captiveShares: number[] = (() => {
  const r = captiveSearch.bestResult;
  if (!isSuccess(r)) return [];
  const total = r.weights.reduce((a, b) => a + (b > 0 ? b : 0), 0);
  return r.weights.map((w) => (total > 0 && w > 0 ? w / total : 0));
})();
const captiveGuidance = isSuccess(captiveSearch.bestResult)
  ? computeUntaggedGuidance({
      cards: CAPTIVE.values.map((v) => ({ value: v })),
      currentWeights: CAPTIVE.weights,
      cardIds: CAPTIVE_IDS,
      livePrice: CAPTIVE.price,
      price: captiveSearch.bestPrice,
      targetEdge: captiveTargets.targetEdge,
      targetWinRate: captiveTargets.targetWinRate,
      nearMissMin: captiveTargets.nearMissMin,
      maxWinCap: captiveTargets.maxWinCap,
      plannedShares: captiveShares,
      relaxations: (captiveSearch.bestResult as ShapeWeightsSuccess).relaxations,
    })
  : null;

check("Captive reproduces: price moves down (snapped), two loss cards pinned at 0.0001%, win-rate floats to ~29.3%", () => {
  const r = captiveSearch.bestResult;
  assert(isSuccess(r), `Captive must plan: ${!isSuccess(r) ? r.error : ""}`);
  assert(
    captiveSearch.bestPrice < CAPTIVE.price,
    `price moves DOWN (got $${captiveSearch.bestPrice})`,
  );
  approx(captiveSearch.bestPrice, 435.43, 1, "landed price ≈ $435.43");
  assert(r.snapped === true, "the landed plan is clean-snapped");
  approx(r.risk.winRate, 0.293, 0.01, "win-rate floats to ≈29.3%");
  assert(
    r.relaxations.some((x) => x.lever === "winRate" && x.applied > x.requested),
    "the win-rate FLOAT-UP relaxation is recorded",
  );
  // The two cheapest loss cards sit at the quantization floor; the $80.28
  // carrier and every winner do not.
  const pinned = CAPTIVE.values.filter(
    (v, i) =>
      v < captiveSearch.bestPrice && isFloorPinnedPct(captiveShares[i]! * 100),
  );
  assert(
    pinned.length === 2 && pinned.includes(33.95) && pinned.includes(18.23),
    `exactly the $33.95/$18.23 cards are floor-pinned (got ${JSON.stringify(pinned)})`,
  );
  // The forcing arithmetic: the loss side's required average sits within a
  // few percent of the max dust value ($80.28) — the degeneracy's cause.
  let winEv = 0;
  let lossMass = 0;
  CAPTIVE.values.forEach((v, i) => {
    if (v >= captiveSearch.bestPrice) winEv += captiveShares[i]! * v;
    else lossMass += captiveShares[i]!;
  });
  const evTarget = captiveSearch.bestPrice * (1 - captiveTargets.targetEdge);
  const lossAvgNeeded = (evTarget - winEv) / lossMass;
  approx(lossAvgNeeded, 80.5, 1, "loss side must average ≈$80.50");
  assert(
    lossAvgNeeded >= 0.95 * 80.28,
    "…which is within a few percent of the $80.28 max dust value",
  );
});

check("Captive guidance: detection fires; add-card band inside [242.75, 485.50) with a solver-verified fix price", () => {
  assert(captiveGuidance !== null, "degenerate detection must fire");
  const g = captiveGuidance!;
  assert(
    g.feasibility.direction === "need-ev-up",
    "the no-float window at 20% wins sits below the EV target (the float's cause)",
  );
  const add = g.suggestions.find((s) => s.kind === "add-card");
  assert(add !== undefined, "an add-card (mid) suggestion is emitted");
  assert(add!.params.band === "near-miss", "near-miss band tried (and provable) first");
  const vMin = Number(add!.params.valueMin);
  const vMax = Number(add!.params.valueMax);
  const vSug = Number(add!.params.suggestedValue);
  const pFix = Number(add!.params.price);
  // The band sits inside the LIVE near-miss band [0.5·485.50, 485.50).
  assert(vMin >= 242.75 - 1e-9, `band floor ≥ $242.75 (got $${vMin})`);
  assert(vMax < 485.5, `band ceiling < $485.50 (got $${vMax})`);
  assert(vSug >= vMin && vSug <= vMax, "suggested value inside the band");
  assert(vSug >= 250 && vSug <= 350, `suggested value ≈ $300 (got $${vSug})`);
  assert(
    Number.isFinite(pFix) && pFix < CAPTIVE.price && pFix > 0.4 * CAPTIVE.price,
    `a concrete fix price rides along (got $${pFix})`,
  );
  assert(add!.proof.feasibleAfter === true, "proven");
  assert(add!.proof.solverVerified === true, "round-tripped through the real solver");
  approx(Number(add!.params.expectedShare), 0.1, 1e-9, "carries the 10% near-miss mass");
});

check("Captive guidance: remove-dead-cards lists exactly the two pinned cards (harmless); accept-as-is carries the WHY", () => {
  const g = captiveGuidance!;
  const dead = g.suggestions.filter((s) => s.kind === "remove-dead-card");
  assert(dead.length === 2, `exactly two dead-card entries (got ${dead.length})`);
  const deadValues = dead.map((s) => Number(s.params.cardValue)).sort((a, b) => a - b);
  assert(
    Math.abs(deadValues[0]! - 18.23) < 1e-9 && Math.abs(deadValues[1]! - 33.95) < 1e-9,
    `the $18.23 and $33.95 cards (got ${JSON.stringify(deadValues)})`,
  );
  for (const s of dead) {
    assert(typeof s.params.cardId === "string", "cardId threaded for the row action");
    assert(s.proof.feasibleAfter === true, "removal re-solved through the engine (harmless)");
  }
  const acceptIdx = g.suggestions.findIndex((s) => s.kind === "accept-as-is");
  assert(acceptIdx >= 0, "accept-as-is is present");
  const accept = g.suggestions[acceptIdx]!;
  assert(accept.proof.feasibleAfter === true, "the plan IS sound");
  approx(Number(accept.params.lossAvgNeeded), 80.5, 1, "the WHY: loss side must average ≈$80.50");
  approx(Number(accept.params.carrierValue), 80.28, 1e-9, "…and only the $80.28 card can carry it");
  // Ranking: add-card first, dead cards next, accept-as-is last.
  assert(g.suggestions[0]!.kind === "add-card", "add-card ranks first");
  assert(acceptIdx === g.suggestions.length - 1, "accept-as-is ranks last");
});

check("Captive enriched: one ~$300 mid card at the (pinned) fix price → NO floor pins, win-rate back at ~20%; guidance clears", () => {
  const add = captiveGuidance!.suggestions.find((s) => s.kind === "add-card")!;
  const pFix = Number(add.params.price);
  const xVal = Number(add.params.suggestedValue); // ≈ $300, inside the band
  const values2 = [...CAPTIVE.values, xVal];
  const weights2 = [...CAPTIVE.weights, 0]; // staged-in card
  // The pinned-price staged plan path (`pinPrice: true` — the suggestion says
  // to pin: the free search prefers snap-closeness and drifts back to the
  // degenerate ladder).
  const r = shapeWeights({
    cards: values2.map((v) => ({ value: v })),
    currentWeights: weights2,
    price: pFix,
    targetEdge: captiveTargets.targetEdge,
    targetWinRate: captiveTargets.targetWinRate,
    maxWinCap: captiveTargets.maxWinCap,
    nearMissMin: captiveTargets.nearMissMin,
    winRateTol: 0.02,
  });
  assert(isSuccess(r), `enriched pool must solve at $${pFix}: ${!isSuccess(r) ? r.error : ""}`);
  assert(r.risk.edge >= captiveTargets.targetEdge - 1e-9, "edge ≥ target");
  approx(r.risk.winRate, 0.2, 0.021, "win rate back at ~20% (was 29.3%)");
  const total = r.weights.reduce((a, b) => a + (b > 0 ? b : 0), 0);
  const shares2 = r.weights.map((w) => (w > 0 ? w / total : 0));
  const pins = values2.filter(
    (v, i) => v < pFix && isFloorPinnedPct(shares2[i]! * 100),
  );
  assert(pins.length === 0, `NO floor-pinned cards (got ${JSON.stringify(pins)})`);
  // The fix loop's re-plan detection: the enriched plan is HEALTHY → null.
  const g2 = computeUntaggedGuidance({
    cards: values2.map((v) => ({ value: v })),
    currentWeights: weights2,
    livePrice: CAPTIVE.price,
    price: pFix,
    targetEdge: captiveTargets.targetEdge,
    targetWinRate: captiveTargets.targetWinRate,
    nearMissMin: captiveTargets.nearMissMin,
    maxWinCap: captiveTargets.maxWinCap,
    plannedShares: shares2,
    relaxations: r.relaxations,
    pinPrice: true,
  });
  assert(g2 === null, "degenerate detection clears on the enriched plan");
});

check("healthy untagged plan: no pins, no float → guidance is null (no banner noise)", () => {
  // Interior loss skew: winners carry ≈52% of the EV at 20% wins, the dust
  // band [3.4, 4.2, 4.8] spreads (no endpoint), win-rate lands ON 20%.
  const values = [40, 30, 20, 4.8, 4.2, 3.4];
  const weights = [3000, 6000, 11000, 30000, 25000, 25000];
  const t = autoRetuneTargets(10, CFG, undefined, 40);
  const r = shapeWeights({
    cards: values.map((v) => ({ value: v })),
    currentWeights: weights,
    price: 10,
    targetEdge: t.targetEdge,
    targetWinRate: t.targetWinRate,
    maxWinCap: t.maxWinCap,
    nearMissMin: t.nearMissMin,
    winRateTol: 0.02,
  });
  assert(isSuccess(r), `healthy control must solve: ${!isSuccess(r) ? r.error : ""}`);
  approx(r.risk.winRate, 0.2, 0.021, "win-rate ON the 20% design (no float)");
  const total = r.weights.reduce((a, b) => a + (b > 0 ? b : 0), 0);
  const shares = r.weights.map((w) => (w > 0 ? w / total : 0));
  values.forEach((v, i) => {
    if (v < 10) {
      assert(
        !isFloorPinnedPct(shares[i]! * 100),
        `no loss card at the floor ($${v} → ${(shares[i]! * 100).toFixed(4)}%)`,
      );
    }
  });
  const g = computeUntaggedGuidance({
    cards: values.map((v) => ({ value: v })),
    currentWeights: weights,
    livePrice: 10,
    price: 10,
    targetEdge: t.targetEdge,
    targetWinRate: t.targetWinRate,
    nearMissMin: t.nearMissMin,
    maxWinCap: t.maxWinCap,
    plannedShares: shares,
    relaxations: r.relaxations,
  });
  assert(g === null, "healthy plan → no guidance");
});

// ── Summary ─────────────────────────────────────────────────────────────
console.log(
  `\n${passes} passed, ${failures.length} failed${
    failures.length > 0 ? ` — ${failures.join(", ")}` : ""
  }`,
);
if (failures.length > 0) process.exit(1);
