/**
 * Retune PLANNER DISCIPLINE harness (owner-lens §2 shape guard).
 *
 * Run with:
 *   npx tsx "src/app/(admin)/packs/__checks__/planner-discipline.ts"
 *
 * NO DB, NO React, NO server imports — pure engine math on inlined fleet-pool
 * fixtures (values + live weights are data snapshots, same practice as the
 * niceness harness' Lucky Pond constants). Pins the SHAPE GUARD: the pure,
 * computable `ladderShape` metric that classifies the owner's flagged
 * degenerate ladders (one-carrier collapse + healthy-card crush) as DEGENERATE
 * while a live-tracking healthy plan stays clean.
 *
 * Every expected number is RE-DERIVED here by running the real engine at the
 * ±10% default budget (and the ±60% suggestion band for the crush cases), never
 * trusted from the spec — the harness pins the CONTRACT (which invariant holds)
 * so a re-tune of the numerals can't silently regress the guard.
 *
 * Exit code 0 = all passed; 1 = at least one failure (printed).
 */

import {
  autoRetuneTargets,
  type ResolvedAutoTargetCfg,
} from "../_lib/auto-targets";
import {
  searchBestPriceForCleanSnap,
  computePackRisk,
  RETUNE_PRICE_BUDGET_DEFAULT_PCT,
  RETUNE_MAX_PRICE_CHANGE_PCT,
} from "../../insights/edge-calc/risk";
import {
  ladderShape,
  LADDER_DEGENERATE_THRESHOLD,
  buildWidePriceProbeSuggestion,
  type ProbeOutcome,
} from "../../insights/edge-calc/tag-guidance";
import {
  packRiskBand,
  isRiskBandExit,
  TAG_CV_K_LO,
  TAG_CV_K_HI,
  RISK_BAND_LIVE_HEADROOM,
} from "../_lib/risk-bands";

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

const CFG: ResolvedAutoTargetCfg = { globalCap: 25000, maxMultCeiling: 100 };

type Pool = {
  name: string;
  price: number;
  values: number[];
  livePcts: number[];
  tag: number | null;
};

// ── Fixture pools (from the fleet dump, spec §6) ────────────────────────
const CHAOS: Pool = {
  name: "10% Chaos",
  price: 4.38,
  values: [905.83, 180, 86.21, 80.82, 52.91, 41.39, 35.65, 25.16, 20.21, 17.62, 14.84, 0.01],
  livePcts: [0.1, 0.1, 0.8, 0.35, 0.25, 0.4, 0.6, 1.2, 0.9, 2.1, 3.2, 90],
  tag: 0.1,
};
const TAILS: Pool = {
  name: "Tails?",
  price: 432.5,
  values: [9602.51, 3419.4, 1680, 1079.99, 815.65, 406.2, 194.1, 61.46, 20.02],
  livePcts: [0.5, 2, 4, 6, 7.5, 10, 10, 10, 50],
  tag: null,
};
const CAPTIVE: Pool = {
  name: "Captive",
  price: 485.5,
  values: [9100, 3247.24, 2040, 1080, 635.14, 80.28, 33.95, 18.23],
  livePcts: [0.5, 4, 5, 7, 8.5, 15, 20, 40],
  tag: null,
};
const BIDOOF: Pool = {
  name: "1% Bidoof",
  price: 3.33,
  values: [502.6, 90, 0.01],
  livePcts: [0.5, 0.5, 99],
  tag: 0.01,
};
const HEAVY_HITTERS: Pool = {
  name: "Heavy Hitters",
  price: 0.95,
  values: [2507.35, 1107.6, 956.96, 896.4, 840, 626.35, 360, 74.68, 0.05],
  livePcts: [0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 99.84],
  tag: 0.01,
};

function toWeights(pcts: number[]): number[] {
  return pcts.map((p) => Math.round(p * 10000));
}
function toShares(pcts: number[]): number[] {
  return pcts.map((p) => p / 100);
}

/** Run the EXACT live-arm solve `planPackTuneLiveUncached` runs, at `band`. */
function solve(p: Pool, band: number) {
  const weights = toWeights(p.livePcts);
  const before = computePackRisk({
    cards: p.values.map((v, i) => ({ value: v, weight: weights[i]! })),
    price: p.price,
  });
  const top = Math.max(...p.values);
  const t = autoRetuneTargets(p.price, CFG, p.tag ?? undefined, top, {
    winRate: before.winRate,
    nearMiss: before.nearMiss,
    edge: before.edge,
    topValue: top,
  });
  // Mirror the caller's tagged near-miss seed.
  const nearMissMin =
    p.tag !== null ? Math.max(0, before.nearMiss) : t.nearMissMin;
  const search = searchBestPriceForCleanSnap({
    cards: p.values.map((v) => ({ value: v })),
    basePrice: p.price,
    targetEdge: t.targetEdge,
    targetWinRate: t.targetWinRate,
    maxWinCap: t.maxWinCap,
    nearMissMin,
    winRateTol: p.tag !== null ? 1e-4 : 0.02,
    currentWeights: weights,
    maxPriceChangePct: band,
    upwardPriceExtensionPct: 0,
    ...(p.tag !== null ? { taggedWinRate: t.targetWinRate } : {}),
  });
  const r = search.bestResult;
  if ("error" in r) {
    return { price: null as number | null, planned: null, snapped: null, r };
  }
  const total = r.weights.reduce((a, x) => a + (x > 0 ? x : 0), 0);
  const planned = r.weights.map((x) => (total > 0 && x > 0 ? x / total : 0));
  return { price: search.bestPrice, planned, snapped: r.snapped ?? false, r };
}

function shapeOf(p: Pool, planned: number[], price: number) {
  return ladderShape(p.values, toShares(p.livePcts), planned, price);
}

// ── 0. Threshold + no-op contract ──────────────────────────────────────
check("threshold constant is 0.25 and live-vs-live is always 0 (no-op never degenerate)", () => {
  assert(
    Math.abs(LADDER_DEGENERATE_THRESHOLD - 0.25) < 1e-12,
    `threshold must be 0.25 (got ${LADDER_DEGENERATE_THRESHOLD})`,
  );
  for (const p of [CHAOS, TAILS, CAPTIVE, BIDOOF, HEAVY_HITTERS]) {
    const s = ladderShape(p.values, toShares(p.livePcts), toShares(p.livePcts), p.price);
    assert(
      Math.abs(s.score) < 1e-12 && !s.degenerate,
      `${p.name}: live-vs-live must score 0 (got ${s.score})`,
    );
  }
});

// ── 1. Chaos (complaint A) — ±10% healthy, ±60% crush DEGENERATE ────────
check("Chaos ±10% ($3.96): healthy ladder (score 0, no crush)", () => {
  const out = solve(CHAOS, RETUNE_PRICE_BUDGET_DEFAULT_PCT);
  assert(out.price !== null, "Chaos ±10% must be feasible");
  assert(
    Math.abs(out.price! - 3.96) <= 0.02,
    `Chaos ±10% price ≈ $3.96 (got $${out.price})`,
  );
  const s = shapeOf(CHAOS, out.planned!, out.price!);
  assert(s.crushedCount === 0, `no crushes (got ${s.crushedCount})`);
  assert(!s.degenerate && s.score < LADDER_DEGENERATE_THRESHOLD, `healthy (score ${s.score})`);
});

check("Chaos ±60% ($1.84, the owner-hated crush): DEGENERATE with ≥5 crushed cards", () => {
  const out = solve(CHAOS, RETUNE_MAX_PRICE_CHANGE_PCT);
  assert(out.price !== null, "Chaos ±60% must be feasible");
  assert(
    out.price! < 2.0,
    `Chaos ±60% cuts the price hard (got $${out.price})`,
  );
  const s = shapeOf(CHAOS, out.planned!, out.price!);
  assert(s.crushedCount >= 5, `≥5 healthy cards crushed (got ${s.crushedCount})`);
  assert(
    s.degenerate && s.score >= LADDER_DEGENERATE_THRESHOLD,
    `the crush is DEGENERATE (score ${s.score})`,
  );
});

// ── 2. Tails? (complaint B) — ±10% DEGENERATE (inversion + absorber) ────
check("Tails? ±10%: DEGENERATE (loss ladder inverted, carrier absorbs)", () => {
  const out = solve(TAILS, RETUNE_PRICE_BUDGET_DEFAULT_PCT);
  assert(out.price !== null, "Tails? ±10% must be feasible");
  const s = shapeOf(TAILS, out.planned!, out.price!);
  assert(s.lossInvArea >= 0.1, `loss ladder is inverted (lossInvArea ${s.lossInvArea})`);
  assert(s.absorberExcess >= 0.25, `a carrier absorbs the loss mass (+${(s.absorberExcess * 100).toFixed(1)}pp)`);
  assert(s.degenerate, `complaint B is DEGENERATE (score ${s.score})`);
});

// ── 3. Captive — DEGENERATE at the default budget (floor pins) ──────────
check("Captive ±10%: DEGENERATE with the two floor-pinned cards crushed", () => {
  const out = solve(CAPTIVE, RETUNE_PRICE_BUDGET_DEFAULT_PCT);
  assert(out.price !== null, "Captive ±10% must be feasible");
  const s = shapeOf(CAPTIVE, out.planned!, out.price!);
  assert(s.crushedCount >= 2, `≥2 crushed cards ($33.95/$18.23 floor pins) (got ${s.crushedCount})`);
  assert(s.absorberExcess >= 0.4, `the carrier absorbs ≥40pp (got +${(s.absorberExcess * 100).toFixed(1)}pp)`);
  assert(s.degenerate, `Captive is DEGENERATE (score ${s.score})`);
  // The crushed indices are the two cheapest loss cards ($33.95 idx 6, $18.23 idx 7).
  assert(
    s.crushedIdx.includes(6) && s.crushedIdx.includes(7),
    `crushed idx must name the $33.95/$18.23 cards (got [${s.crushedIdx.join(",")}])`,
  );
});

// ── 4. Bidoof / Heavy Hitters — healthy at BOTH bands (no false positive) ─
check("Bidoof: healthy at ±10% AND ±60% (no false degenerate flag)", () => {
  for (const band of [RETUNE_PRICE_BUDGET_DEFAULT_PCT, RETUNE_MAX_PRICE_CHANGE_PCT]) {
    const out = solve(BIDOOF, band);
    assert(out.price !== null, `Bidoof must be feasible at band ${band}`);
    const s = shapeOf(BIDOOF, out.planned!, out.price!);
    assert(s.crushedCount === 0, `Bidoof band ${band}: no crushes (got ${s.crushedCount})`);
    assert(!s.degenerate, `Bidoof band ${band} healthy (score ${s.score})`);
  }
});

check("Heavy Hitters: deep 15× trims are NOT crushes (healthy ladder)", () => {
  const out = solve(HEAVY_HITTERS, RETUNE_PRICE_BUDGET_DEFAULT_PCT);
  // Heavy Hitters may be infeasible in-band or feasible — either way the guard
  // must not FALSELY crush its legitimate deep trims when it IS feasible.
  if (out.price === null) {
    // In-band infeasibility is honest — nothing to shape-check.
    return;
  }
  const s = shapeOf(HEAVY_HITTERS, out.planned!, out.price!);
  assert(
    !s.degenerate,
    `Heavy Hitters' legit deep trims must not read DEGENERATE (score ${s.score})`,
  );
});

// ── 5. Crush predicate precision — a cap-dropped 0 is NOT a crush ────────
check("a card planned to exactly 0 is a cap event, NOT a crush", () => {
  // Live carries a card; the plan parks it at exactly 0 (cap-dropped).
  const values = [100, 50, 0.05];
  const live = [0.01, 0.09, 0.9];
  const planned = [0, 0.1, 0.9]; // first card cap-dropped to 0
  const s = ladderShape(values, live, planned, 60);
  assert(s.crushedCount === 0, "a 0-planned card is a cap event, never a crush");
});

check("a live card crushed 100×+ under 0.002% IS a crush", () => {
  const values = [100, 50, 0.05];
  const live = [0.05, 0.05, 0.9]; // 5% live on the $100 card
  const planned = [0.00001, 0.09999, 0.9]; // crushed to 0.001% (5000×)
  const s = ladderShape(values, live, planned, 60);
  assert(s.crushedCount === 1, `the crushed card is counted (got ${s.crushedCount})`);
  assert(s.crushedIdx[0] === 0, "the $100 card is flagged");
  assert(s.crushedLiveMass >= 0.05 - 1e-9, "its live mass is accumulated");
});

// ── 6. Risk leverage bands (owner-lens §4 / Pattern 6) ──────────────────
check("risk band: tag-law base = k·sqrt((1−t)/t), widened to a deliberate hot-runner", () => {
  // Chaos: 10% tag, live CV 7.95 (way above the tag-law band) — the owner's
  // deliberate leverage defines its OWN band (widened to live + 15% headroom).
  const chaos = packRiskBand({ tag: 0.1, price: 4.38, liveCv: 7.95 });
  const s = Math.sqrt((1 - 0.1) / 0.1);
  assert(chaos.source === "tag-law", "a tagged pack uses the lottery CV law");
  assert(Math.abs(chaos.lo - TAG_CV_K_LO * s) < 1e-9, `lo = k_lo·sqrt (got ${chaos.lo})`);
  // Base hi would be k_hi·sqrt; the widen pushes it up to live·(1+headroom).
  assert(TAG_CV_K_HI * s < 7.95 * (1 + RISK_BAND_LIVE_HEADROOM), "the hot-runner is above the base band");
  assert(
    Math.abs(chaos.hi - 7.95 * (1 + RISK_BAND_LIVE_HEADROOM)) < 1e-9,
    `hi widened to live+${RISK_BAND_LIVE_HEADROOM * 100}% (got ${chaos.hi})`,
  );
  assert(chaos.widenedToLive, "the live CV sits outside the base band → widened");
  // Chaos ±60% plan CV 8.66 is INSIDE its widened band → no badge (the crush
  // there is the shape guard's catch, not the risk band's — complementary).
  assert(!isRiskBandExit(8.66, chaos), "Chaos ±60% plan CV 8.66 is in-band (no risk badge)");
  // A synthetic CV outside the band DOES exit.
  assert(isRiskBandExit(1.0, chaos), "a CV below the band exits");
  assert(isRiskBandExit(20, chaos), "a CV above the band exits");
});

check("risk band: untagged uses the fleet price bracket", () => {
  // Tails: untagged, price 432.5 → the >$100 bracket [0.8, 2.5].
  const tails = packRiskBand({ tag: null, price: 432.5, liveCv: 2.32 });
  assert(tails.source === "fleet-bracket", "an untagged pack uses the price bracket");
  assert(tails.lo <= 0.8 + 1e-9, "the >$100 bracket floor is 0.8");
  // A cheap untagged pack uses the <$5 bracket.
  const cheap = packRiskBand({ tag: null, price: 3, liveCv: 3 });
  assert(cheap.source === "fleet-bracket", "cheap untagged → bracket");
  assert(cheap.hi >= 5.7 - 1e-9, "the <$5 bracket ceiling is 5.7 (widest — spicy cheap packs)");
});

check("risk band: a marginal low-CV untagged pack exits its band (Pattern 6 badge)", () => {
  // Combat-Ready class: live CV 1.0 in the <$5 bracket [1.1, 5.7], widened to
  // [0.85, 5.7]; a plan landing at CV 0.8 exits (flattened below the band).
  const combat = packRiskBand({ tag: null, price: 3, liveCv: 1.0 });
  assert(isRiskBandExit(0.8, combat), "a plan CV 0.8 exits the widened band → badge");
  assert(!isRiskBandExit(1.0, combat), "the live CV itself is always in-band (widen guarantee)");
});

check("risk band: NaN/degenerate CV is exit-safe (never a false badge)", () => {
  const band = packRiskBand({ tag: null, price: 10, liveCv: 2 });
  assert(!isRiskBandExit(Number.NaN, band), "NaN CV → no exit");
  assert(!isRiskBandExit(0, band), "0 CV → no exit");
  assert(!isRiskBandExit(-1, band), "negative CV → no exit");
  // A non-finite live CV skips the widen (base band stands, no crash).
  const noLive = packRiskBand({ tag: 0.05, price: 20, liveCv: 0 });
  assert(Number.isFinite(noLive.lo) && Number.isFinite(noLive.hi), "band stays finite with no live CV");
  assert(!noLive.widenedToLive, "no live CV → not widened");
});

// ── 7. Wide-price probe suggestion (owner-lens §1.4) ────────────────────
const CLEAN: ProbeOutcome = {
  feasible: true,
  price: 100,
  allNice: true,
  snapped: true,
  taggedAccuracyHit: true,
  shapeDegenerate: false,
};

check("wide probe: infeasible default → feasible wide emits a beyond-budget price-move", () => {
  const def: ProbeOutcome = {
    feasible: false,
    price: 100,
    allNice: null,
    snapped: null,
    taggedAccuracyHit: null,
    shapeDegenerate: null,
  };
  const wide: ProbeOutcome = { ...CLEAN, price: 159.5 };
  const s = buildWidePriceProbeSuggestion({
    livePrice: 100,
    tagged: true,
    tag: 0.1,
    def,
    wide,
    wideEdge: 0.11,
    wideWinRate: 0.1,
  });
  assert(s !== null, "infeasible→feasible is a rung crossing → suggestion emitted");
  assert(s!.kind === "price-move", "the suggestion is a price-move");
  assert(s!.params.price === 159.5, "carries the exact far price");
  assert(s!.params.beyondBudget === 1, "flagged beyond-budget");
  assert(Math.abs(Number(s!.params.deltaPct) - 59.5) < 0.05, "signed delta +59.5%");
  assert(s!.proof.solverVerified === true, "the probe is a full solve (solver-verified)");
  assert(/outside the ±10% budget/.test(s!.humanCopy), "copy names the budget");
});

check("wide probe: a COUNT-only improvement does NOT qualify (Bidoof class)", () => {
  // Default is feasible+snapped but off-nice; wide is ALSO off-nice (fewer
  // off-nice cards is a count gain, not a rung crossing).
  const def: ProbeOutcome = { ...CLEAN, allNice: false };
  const wide: ProbeOutcome = { ...CLEAN, price: 59, allNice: false };
  const s = buildWidePriceProbeSuggestion({
    livePrice: 100,
    tagged: true,
    tag: 0.01,
    def,
    wide,
    wideEdge: 0.11,
    wideWinRate: 0.01,
  });
  assert(s === null, "off-nice → off-nice is a count gain, not a crossing → no suggestion");
});

check("wide probe: an already-clean default yields no suggestion", () => {
  const s = buildWidePriceProbeSuggestion({
    livePrice: 100,
    tagged: true,
    tag: 0.1,
    def: CLEAN,
    wide: { ...CLEAN, price: 60 },
    wideEdge: 0.11,
    wideWinRate: 0.1,
  });
  assert(s === null, "no rung to cross when the default is already clean");
});

check("wide probe: off-nice→all-nice crossing (tagged) emits; snapped→snapped alone does not", () => {
  // Rung 4: tagged off-nice → all-nice.
  const niceCross = buildWidePriceProbeSuggestion({
    livePrice: 100,
    tagged: true,
    tag: 0.1,
    def: { ...CLEAN, allNice: false },
    wide: { ...CLEAN, price: 40, allNice: true },
    wideEdge: 0.11,
    wideWinRate: 0.1,
  });
  assert(niceCross !== null, "off-nice→all-nice is a crossing");
  assert(/round number/.test(niceCross!.humanCopy), "copy names the all-nice benefit");
  // An infeasible wide can never be a suggestion.
  const wideInfeasible = buildWidePriceProbeSuggestion({
    livePrice: 100,
    tagged: false,
    tag: 0.2,
    def: { feasible: false, price: 100, allNice: null, snapped: null, taggedAccuracyHit: null, shapeDegenerate: null },
    wide: { feasible: false, price: 0, allNice: null, snapped: null, taggedAccuracyHit: null, shapeDegenerate: null },
    wideEdge: 0,
    wideWinRate: 0,
  });
  assert(wideInfeasible === null, "an infeasible wide probe never emits");
});

check("wide probe: untagged unsnapped→snapped and degenerate→healthy both cross", () => {
  const snapCross = buildWidePriceProbeSuggestion({
    livePrice: 100,
    tagged: false,
    tag: 0.2,
    def: { feasible: true, price: 100, allNice: null, snapped: false, taggedAccuracyHit: null, shapeDegenerate: false },
    wide: { feasible: true, price: 90, allNice: null, snapped: true, taggedAccuracyHit: null, shapeDegenerate: false },
    wideEdge: 0.11,
    wideWinRate: 0.2,
  });
  assert(snapCross !== null, "untagged unsnapped→snapped is a crossing");
  assert(snapCross!.params.allNice === -1, "untagged allNice param is -1 (n/a)");
  const shapeCross = buildWidePriceProbeSuggestion({
    livePrice: 100,
    tagged: false,
    tag: 0.2,
    def: { feasible: true, price: 100, allNice: null, snapped: true, taggedAccuracyHit: null, shapeDegenerate: true },
    wide: { feasible: true, price: 70, allNice: null, snapped: true, taggedAccuracyHit: null, shapeDegenerate: false },
    wideEdge: 0.11,
    wideWinRate: 0.2,
  });
  assert(shapeCross !== null, "degenerate→healthy is a crossing");
  assert(/ladder stays healthy/.test(shapeCross!.humanCopy), "copy names the shape benefit");
});

// ── Summary ─────────────────────────────────────────────────────────────
console.log(
  `\n${passes} passed, ${failures.length} failed${
    failures.length > 0 ? ` — ${failures.join(", ")}` : ""
  }`,
);
if (failures.length > 0) process.exit(1);
