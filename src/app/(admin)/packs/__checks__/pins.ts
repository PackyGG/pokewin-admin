/**
 * Retune V2 OWNER-PINNED ODDS harness (pure, no DB).
 *
 * Run with:
 *   npx tsx "src/app/(admin)/packs/__checks__/pins.ts"
 *
 * Pins every contract of the `pinnedShares` engine feature (risk.ts) + the
 * `pinnedOdds` plumbing (`retune-params.ts`):
 *
 *   1.  HOLD: a pinned share survives solve + quantize + SNAP to ≤ 1e-9
 *       (design contract: pins are held EXACTLY; the snap never moves them —
 *       a pin is an owner-chosen number, exempt from ladder membership).
 *   2.  TAG EXACT WITH WIN-BAND PINS: pinned win shares count toward the tag
 *       sum; the free winners absorb the residual; |winRate − tag| ≤ 1e-4.
 *   3.  PINS-INFEASIBLE arms — each refusal is DATA with a computable
 *       suggestion: EV overshoot (pins force edge below target), tag
 *       overshoot (pins alone exceed the tag, excess in the copy),
 *       cap-dropped pin (the raise-cap remedy attached).
 *   4.  FULLY-PINNED pools: accepted when the edge lands in
 *       [target, target + ONE_SIDED_EDGE_EXCESS_TOL]; refused honestly below
 *       (Drafts copy) and above the band.
 *   5.  LEGACY: an empty pin list produces byte-identical results to no pins.
 *   6.  THE MASAKI FIXTURE — the owner's REAL pack (read-only prod probe,
 *       2026-07-03): "Heavy Hitters" (a60d5782-72c7-4814-83a4-aab0e4ecaf77),
 *       price $0.95, DB tag %1, pool values
 *       [2507.35, 1107.60, 956.96, 896.40, 840.00, 626.35, 360.00, 74.68,
 *        0.05] with live weights [30, 50, 80, 150, 150, 230, 310, 1000,
 *        998000] — 99.80% live share on the $0.05 dust. The $2507.35 card is
 *       "[PSA 9] MASAKI Machamp".
 *
 *       WHICH ARM THE REAL NUMBERS DICTATE: at the live $0.95 price the %1
 *       tag cap is autoMaxWinCap(0.95, {25000, ×100}, 0.01) =
 *       min(25000, 0.95·100·(0.20/0.01)·1.15) = $2,184.99…, and
 *       $2507.35 > cap — the cap pre-filter would DROP the MASAKI Machamp
 *       before any odds are assigned. Pinning it at 0.0005% is therefore
 *       REFUSED as data with the raise-cap suggestion attached (NOT a plan
 *       holding the pin). The counterfactual (cap raised above the card) is
 *       exercised as its own check; observed verdict on the real numbers:
 *       the engine DOES produce a valid plan — price search lands $1.17
 *       (within the ±60% band), edge 11.023% (the pack's own curve target),
 *       tag exactly 1%, the MASAKI pin held at exactly 0.0005%.
 *
 * Exit code 0 = all passed; 1 = at least one failure (printed).
 */

import {
  ONE_SIDED_EDGE_EXCESS_TOL,
  RETUNE_MAX_PRICE_CHANGE_PCT,
  RETUNE_PRICE_BUDGET_DEFAULT_PCT,
  TAGGED_WINRATE_TOLERANCE,
  computePackRisk,
  searchBestPriceForCleanSnap,
  shapeWeights,
  type ShapeWeightsResult,
  type ShapeWeightsSuccess,
} from "../../insights/edge-calc/risk";
import {
  DEFAULT_MAX_MULT_CEILING,
  autoMaxWinCap,
  autoRetuneTargets,
  autoTargetEdge,
  resolveIntendedHitRate,
  type ResolvedAutoTargetCfg,
} from "../_lib/auto-targets";
import { buildRetuneSearchParams } from "../_lib/retune-params";
import {
  computeTagGuidance,
  computeUntaggedGuidance,
} from "../../insights/edge-calc/tag-guidance";

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

function assertSuccess(r: ShapeWeightsResult, label: string): ShapeWeightsSuccess {
  if ("error" in r) {
    throw new Error(`${label}: expected success, got ${r.limit.kind} — ${r.error}`);
  }
  return r;
}

function shareOf(weights: readonly number[], idx: number): number {
  let total = 0;
  for (const w of weights) if (Number.isFinite(w) && w > 0) total += w;
  return total > 0 ? weights[idx]! / total : 0;
}

// ── Fixtures ────────────────────────────────────────────────────────────

/** Untagged anchored pool (dust · near-miss · win · grail) at a $2.50 ticket. */
const untagged = {
  cards: [{ value: 0.35 }, { value: 1.8 }, { value: 4.2 }, { value: 120 }],
  price: 2.5,
  targetEdge: 0.1105,
  targetWinRate: 0.2,
  maxWinCap: 250,
  nearMissMin: 0.1,
  winRateTol: 0.02,
  currentWeights: [880000, 90000, 29900, 100],
};

/**
 * Feasible TAGGED 1% lottery pool at a $1.00 ticket (house-ladder shaped:
 * three winners at live odds 0.05% / 0.35% / 0.60% — win EV $0.925 — and two
 * dust values for EV freedom). evTarget $0.89 sits inside the anchored
 * reachable interval (the RC4 concentration knob covers the low side).
 */
const tagged1pct = {
  cards: [
    { value: 250 },
    { value: 100 },
    { value: 75 },
    { value: 0.05 },
    { value: 0.02 },
  ],
  price: 1.0,
  targetEdge: 0.11,
  targetWinRate: 0.01,
  maxWinCap: 2300,
  nearMissMin: 0,
  winRateTol: TAGGED_WINRATE_TOLERANCE,
  currentWeights: [500, 3500, 6000, 600000, 390000],
  winRateIsHard: true as const,
};

// ── 1. HOLD: pin exact through solve + quantize ─────────────────────────
check("pin held to ≤ 1e-9 through solve + quantize (untagged anchored pool)", () => {
  const r = assertSuccess(
    shapeWeights({ ...untagged, pinnedShares: [{ index: 3, share: 0.0005 }] }),
    "pinned solve",
  );
  const held = shareOf(r.weights, 3);
  assert(
    Math.abs(held - 0.0005) <= 1e-9,
    `pin drifted: held ${held} vs pinned 0.0005 (|err| ${Math.abs(held - 0.0005)})`,
  );
  assert(r.edge >= untagged.targetEdge - 1e-9, "edge must stay ≥ target");
});

// ── 1b. HOLD through the SNAP (price search lands a clean ladder) ───────
check("pin held to ≤ 1e-9 through the price search + clean-ladder SNAP", () => {
  const s = searchBestPriceForCleanSnap({
    ...untagged,
    basePrice: untagged.price,
    maxPriceChangePct: 0.6,
    upwardPriceExtensionPct: 0,
    pinnedShares: [{ index: 3, share: 0.0005 }],
  });
  const best = assertSuccess(s.bestResult, "pinned search");
  assert(best.snapped === true, "the sweep must find a clean-snap price for this pool");
  const held = shareOf(best.weights, 3);
  assert(
    Math.abs(held - 0.0005) <= 1e-9,
    `pin drifted through the snap: held ${held} (|err| ${Math.abs(held - 0.0005)})`,
  );
});

// ── 2. TAG EXACT with a win-band pin ────────────────────────────────────
check("tagged 1%: win-band pin counts toward the tag; free winners absorb; tag exact ≤ 1e-4", () => {
  const r = assertSuccess(
    shapeWeights({ ...tagged1pct, pinnedShares: [{ index: 0, share: 0.0002 }] }),
    "tagged pinned solve",
  );
  const held = shareOf(r.weights, 0);
  assert(
    Math.abs(held - 0.0002) <= 1e-9,
    `jackpot pin drifted: held ${held} (|err| ${Math.abs(held - 0.0002)})`,
  );
  assert(
    Math.abs(r.risk.winRate - 0.01) <= TAGGED_WINRATE_TOLERANCE + 1e-12,
    `tag broken: winRate ${(r.risk.winRate * 100).toFixed(4)}% vs 1%`,
  );
  assert(r.edge >= tagged1pct.targetEdge - 1e-9, "edge ≥ target");
  assert(
    r.edge <= tagged1pct.targetEdge + ONE_SIDED_EDGE_EXCESS_TOL + 0.001 + 1e-9,
    `edge ${(r.edge * 100).toFixed(3)}% above the accepted band`,
  );
});

// ── 3a. PINS-INFEASIBLE: EV overshoot (edge would land below target) ────
check("pins-infeasible (EV overshoot): pinned value forces edge below target — computable suggestion", () => {
  const r = shapeWeights({
    ...tagged1pct,
    // 0.5% on the $250 jackpot alone carries $1.25 of EV — the $0.89 budget
    // is blown before the rest of the pool places a single unit.
    pinnedShares: [{ index: 0, share: 0.005 }],
  });
  assert("error" in r, "expected the error arm");
  assert(r.limit.kind === "pins-infeasible", `kind ${r.limit.kind}`);
  assert(r.limit.suggestion.length > 0, "suggestion must be present");
  assert(
    /below the .*target|Drafts/i.test(r.limit.detail + r.limit.suggestion),
    "copy must name the below-target direction / Drafts remedy",
  );
});

// ── 3b. PINS-INFEASIBLE: pins alone exceed the tag (excess in the copy) ─
check("pins-infeasible (tag overshoot): pinned win shares exceed the tag, excess quantified", () => {
  const r = shapeWeights({
    ...tagged1pct,
    pinnedShares: [
      { index: 0, share: 0.008 },
      { index: 1, share: 0.004 },
    ], // 1.2% pinned wins on a 1% tag
  });
  assert("error" in r, "expected the error arm");
  assert(r.limit.kind === "pins-infeasible", `kind ${r.limit.kind}`);
  assert(
    r.limit.detail.includes("0.2000"),
    `excess (0.2000pp) must be quantified in the copy — got: ${r.limit.detail}`,
  );
});

// ── 3c. PINS-INFEASIBLE: cap-dropped pin carries the raise-cap remedy ───
check("pins-infeasible (cap-dropped): pin above maxWinCap refused with the raise-cap suggestion", () => {
  const r = shapeWeights({
    ...untagged,
    maxWinCap: 100, // the $120 grail is now over the cap
    pinnedShares: [{ index: 3, share: 0.0005 }],
  });
  assert("error" in r, "expected the error arm");
  assert(r.limit.kind === "pins-infeasible", `kind ${r.limit.kind}`);
  assert(
    /max-win cap/i.test(r.limit.suggestion),
    `suggestion must carry the raise-cap remedy — got: ${r.limit.suggestion}`,
  );
});

// ── 4. FULLY-PINNED pools ───────────────────────────────────────────────
check("fully-pinned pool ACCEPTED when the edge lands in [target, target+0.25pp]", () => {
  // EV = 0.442211·10 + 0.557789·0.05 = 4.45 → edge exactly 11.00% at $5.
  const r = assertSuccess(
    shapeWeights({
      cards: [{ value: 10 }, { value: 0.05 }],
      price: 5,
      targetEdge: 0.1099,
      targetWinRate: 0.2,
      pinnedShares: [
        { index: 0, share: 0.442211 },
        { index: 1, share: 0.557789 },
      ],
    }),
    "fully-pinned",
  );
  assert(
    r.edge >= 0.1099 - 1e-9 &&
      r.edge <= 0.1099 + ONE_SIDED_EDGE_EXCESS_TOL + 1e-9,
    `edge ${(r.edge * 100).toFixed(3)}% outside the accepted band`,
  );
  const held = shareOf(r.weights, 0);
  assert(Math.abs(held - 0.442211) <= 1e-9, `share drifted: ${held}`);
  assert(r.snapped === true, "nothing unpinned remains — owner numbers count as final");
});

check("fully-pinned pool REFUSED below target (Drafts copy)", () => {
  const r = shapeWeights({
    cards: [{ value: 10 }, { value: 0.05 }],
    price: 5,
    targetEdge: 0.1099,
    targetWinRate: 0.2,
    pinnedShares: [
      { index: 0, share: 0.4473 },
      { index: 1, share: 0.5527 },
    ], // edge ≈ 9.99% — below the target
  });
  assert("error" in r, "expected the error arm");
  assert(r.limit.kind === "pins-infeasible", `kind ${r.limit.kind}`);
  assert(/below/i.test(r.limit.detail), "detail names the below-target side");
  assert(/Drafts/.test(r.limit.suggestion), "the deliberate-below-target path points to Drafts");
});

check("fully-pinned pool REFUSED above the accepted band", () => {
  const r = shapeWeights({
    cards: [{ value: 10 }, { value: 0.05 }],
    price: 5,
    targetEdge: 0.1099,
    targetWinRate: 0.2,
    pinnedShares: [
      { index: 0, share: 0.43 },
      { index: 1, share: 0.57 },
    ], // edge ≈ 13.4% — far above target+0.25pp
  });
  assert("error" in r, "expected the error arm");
  assert(r.limit.kind === "pins-infeasible", `kind ${r.limit.kind}`);
  assert(/above/i.test(r.limit.detail), "detail names the above-band side");
});

// ── 5. LEGACY: empty pins ≡ no pins (byte-identical) ────────────────────
check("empty pinnedShares array ≡ omitted (weights byte-identical)", () => {
  const a = assertSuccess(shapeWeights({ ...untagged }), "no pins");
  const b = assertSuccess(
    shapeWeights({ ...untagged, pinnedShares: [] }),
    "empty pins",
  );
  assert(
    JSON.stringify(a.weights) === JSON.stringify(b.weights),
    "weights must be byte-identical",
  );
  assert(a.edge === b.edge && a.snapped === b.snapped, "results must match");
});

// ── 6. THE MASAKI FIXTURE (real prod numbers, read-only probe 2026-07-03) ──
// "Heavy Hitters" — price $0.95, DB tag %1, the $2507.35 "[PSA 9] MASAKI
// Machamp" at live 0.0030%, 99.80% live share on the $0.05 dust.
const MASAKI = {
  name: "Heavy Hitters",
  tags: ["%1"],
  price: 0.95,
  pool: [
    { cardId: "c-masaki-machamp", value: 2507.35, weight: 30 },
    { cardId: "c-shining-steelix", value: 1107.6, weight: 50 },
    { cardId: "c-snorlax-lvx", value: 956.96, weight: 80 },
    { cardId: "c-regirock-star", value: 896.4, weight: 150 },
    { cardId: "c-shining-tyranitar", value: 840.0, weight: 150 },
    { cardId: "c-golem-skyridge", value: 626.35, weight: 230 },
    { cardId: "c-poliwrath-h24", value: 360.0, weight: 310 },
    { cardId: "c-hariyama-ex", value: 74.68, weight: 1000 },
    { cardId: "c-grapploct-dust", value: 0.05, weight: 998000 },
  ],
};
const MASAKI_CFG: ResolvedAutoTargetCfg = {
  // The pure-harness defaults (risk-config's DEFAULT_MAX_WIN_CAP = 25000 —
  // not importable here without pulling the adminDb module graph).
  globalCap: 25000,
  maxMultCeiling: DEFAULT_MAX_MULT_CEILING,
};

check("MASAKI fixture: live share sanity (probe numbers reproduce 99.80% dust / 0.0030% Machamp)", () => {
  const total = MASAKI.pool.reduce((s, c) => s + c.weight, 0);
  assert(total === 1_000_000, `probe total ${total}`);
  assert(
    Math.abs(MASAKI.pool[8]!.weight / total - 0.998) < 1e-12,
    "dust live share must be 99.80%",
  );
  assert(
    Math.abs(MASAKI.pool[0]!.weight / total - 0.00003) < 1e-12,
    "MASAKI Machamp live share must be 0.0030%",
  );
});

check("MASAKI fixture: pin 2507.35 @ 0.0005% at the live price → CAP-REFUSAL arm (raise-cap suggestion)", () => {
  // The REAL resolved targets at the live $0.95 price: %1 DB tag → hit-rate
  // 0.01 → cap = min(25000, 0.95·100·(0.20/0.01)·1.15) ≈ $2,185 < $2,507.35.
  const hitRate = resolveIntendedHitRate(MASAKI.name, MASAKI.tags);
  assert(hitRate === 0.01, `resolved tag ${hitRate}`);
  const poolTop = Math.max(...MASAKI.pool.map((c) => c.value));
  const targets = autoRetuneTargets(MASAKI.price, MASAKI_CFG, hitRate, poolTop);
  assert(
    targets.maxWinCap < 2507.35 && targets.maxWinCap > 2184,
    `the %1 cap at $0.95 must sit just below the Machamp (got $${targets.maxWinCap.toFixed(2)})`,
  );
  // Live near-miss band [0.475, 0.95) is empty → seeded nearMissMin = 0.
  const search = searchBestPriceForCleanSnap(
    buildRetuneSearchParams("staged", {
      cards: MASAKI.pool.map((c) => ({ value: c.value, cardId: c.cardId })),
      basePrice: MASAKI.price,
      targetEdge: targets.targetEdge,
      targetWinRate: targets.targetWinRate,
      maxWinCap: targets.maxWinCap,
      nearMissMin: 0,
      winRateTol: 0.02,
      currentWeights: MASAKI.pool.map((c) => c.weight),
      intendedHitRate: targets.intendedHitRate,
      priceBudgetPct: RETUNE_MAX_PRICE_CHANGE_PCT,
      pinnedOdds: [{ cardId: "c-masaki-machamp", pct: 0.0005 }],
    }),
  );
  const r = search.bestResult;
  assert("error" in r, "the real numbers dictate a refusal, not a plan");
  assert(r.limit.kind === "pins-infeasible", `kind ${r.limit.kind}`);
  assert(
    r.limit.detail.includes("2507.35"),
    `detail must name the pinned card's value — got: ${r.limit.detail}`,
  );
  assert(
    /raise the pack's max-win cap/i.test(r.limit.suggestion),
    `the raise-cap remedy must ride the refusal — got: ${r.limit.suggestion}`,
  );
});

check("MASAKI counterfactual: cap raised above the Machamp → the pin itself is accepted by the pre-filter", () => {
  // With the cap lifted over $2,507.35 the pin passes the pre-filter; whether
  // the plan then lands is the ENGINE's honest verdict on this extreme pool
  // (live 0.198% winners vs the exact 1% tag). Contract pinned here: the
  // result is EITHER a success holding the pin at exactly 0.0005% AND the
  // tag at 1e-4, OR a structured limit that is NOT the cap refusal — never a
  // silent drop of the pinned card.
  const hitRate = resolveIntendedHitRate(MASAKI.name, MASAKI.tags)!;
  const targets = autoRetuneTargets(MASAKI.price, MASAKI_CFG, hitRate, 2507.35);
  const search = searchBestPriceForCleanSnap(
    buildRetuneSearchParams("staged", {
      cards: MASAKI.pool.map((c) => ({ value: c.value, cardId: c.cardId })),
      basePrice: MASAKI.price,
      targetEdge: targets.targetEdge,
      targetWinRate: targets.targetWinRate,
      maxWinCap: 2600, // raised over the Machamp (the suggestion followed)
      nearMissMin: 0,
      winRateTol: 0.02,
      currentWeights: MASAKI.pool.map((c) => c.weight),
      intendedHitRate: targets.intendedHitRate,
      priceBudgetPct: RETUNE_MAX_PRICE_CHANGE_PCT,
      pinnedOdds: [{ cardId: "c-masaki-machamp", pct: 0.0005 }],
    }),
  );
  const r = search.bestResult;
  if ("error" in r) {
    assert(
      !/max-win cap/i.test(r.limit.suggestion) || !r.limit.detail.includes("2507.35"),
      "with the cap raised the refusal must NOT be the cap arm",
    );
    console.log(
      `      (counterfactual verdict: ${r.limit.kind} — ${r.limit.detail.slice(0, 110)}…)`,
    );
  } else {
    const held = shareOf(r.weights, 0);
    assert(
      Math.abs(held - 0.000005) <= 1e-9,
      `pin drifted in the counterfactual: ${held}`,
    );
    assert(
      Math.abs(r.risk.winRate - 0.01) <= TAGGED_WINRATE_TOLERANCE + 1e-12,
      `tag broken in the counterfactual: ${(r.risk.winRate * 100).toFixed(4)}%`,
    );
    console.log(
      `      (counterfactual verdict: PLAN at $${search.bestPrice.toFixed(2)}, edge ${(r.edge * 100).toFixed(3)}%, pin held)`,
    );
  }
});

// ── 7. PINS-AWARE GUIDANCE (owner incident "1% Bidoof", 2026-07-07) ─────
//
// The staged solve holds typed pins EXACT while the guidance previously
// modeled the LIVE odds — its "solver-verified" computed fix ($3.35 @
// 11.257%) then REFUSED under the pins (edge 35.9%), leaving the operator
// stuck. Contract: guidance built WITH `pinnedShares` models the pinned
// point-EV, and its price-edge-exact fix round-trips `shapeWeights` WITH
// the pins (appliable by definition).

const BIDOOF = {
  values: [502.6, 90, 0.01],
  liveWeights: [5000, 5000, 990000], // 0.5% / 0.5% / 99%
  pins: [
    { index: 0, share: 0.003 },
    { index: 1, share: 0.007 },
    { index: 2, share: 0.99 },
  ],
  price: 3.33,
  tag: 0.01,
  cfg: { globalCap: 25000, maxMultCeiling: DEFAULT_MAX_MULT_CEILING },
};

function bidoofGuidance(withPins: boolean) {
  const cap = autoMaxWinCap(BIDOOF.price, BIDOOF.cfg, BIDOOF.tag);
  const top = Math.max(...BIDOOF.values.filter((v) => v <= cap));
  return computeTagGuidance({
    cards: BIDOOF.values.map((v) => ({ value: v })),
    currentWeights: BIDOOF.liveWeights,
    price: BIDOOF.price,
    targetEdge: autoTargetEdge({ price: BIDOOF.price, maxWin: top }),
    tag: BIDOOF.tag,
    nearMissMin: 0,
    maxWinCap: cap,
    cfg: BIDOOF.cfg,
    ...(withPins ? { pinnedShares: BIDOOF.pins } : {}),
  });
}

const bidoofPinnedEv = BIDOOF.pins.reduce(
  (a, p) => a + p.share * BIDOOF.values[p.index]!,
  0,
);

check("guidance WITH pins models the pinned point-EV, not the live odds", () => {
  const g = bidoofGuidance(true);
  assert(!g.feasibility.feasible, "the pinned pool is infeasible at $3.33");
  assert(g.feasibility.saturated, "fully pinned ⇒ saturated");
  assert(
    Math.abs(g.feasibility.evMin - bidoofPinnedEv) < 1e-9 &&
      Math.abs(g.feasibility.evMax - bidoofPinnedEv) < 1e-9,
    `interval must be the pinned point ${bidoofPinnedEv.toFixed(4)} (got [${g.feasibility.evMin.toFixed(4)}, ${g.feasibility.evMax.toFixed(4)}])`,
  );
});

check("the pins-aware computed fix is APPLIABLE (solver accepts WITH the pins)", () => {
  const g = bidoofGuidance(true);
  const s = g.suggestions.find((x) => x.kind === "price-edge-exact");
  assert(s !== undefined, "a price-edge-exact fix is emitted");
  const p2 = Number(s!.params.price);
  const e2 = Number(s!.params.edgeTarget);
  assert(
    Math.abs(p2 * (1 - e2) - bidoofPinnedEv) < 0.005,
    `the fix must price the PINNED payout (${(p2 * (1 - e2)).toFixed(4)} vs ${bidoofPinnedEv.toFixed(4)})`,
  );
  assert(
    s!.proof.solverVerified === true,
    "the top fix round-trips the pinned solver",
  );
  const r = shapeWeights({
    cards: BIDOOF.values.map((v) => ({ value: v })),
    price: p2,
    targetEdge: e2,
    targetWinRate: BIDOOF.tag,
    maxWinCap: autoMaxWinCap(p2, BIDOOF.cfg, BIDOOF.tag),
    nearMissMin: 0,
    winRateTol: TAGGED_WINRATE_TOLERANCE,
    currentWeights: BIDOOF.liveWeights,
    winRateIsHard: true,
    pinnedShares: BIDOOF.pins.map((p) => ({ ...p })),
  });
  const ok = assertSuccess(r, "apply the computed fix with the pins held");
  assert(
    Math.abs(ok.risk.winRate - BIDOOF.tag) <= TAGGED_WINRATE_TOLERANCE + 1e-12,
    `tag exact under the fix (got ${(ok.risk.winRate * 100).toFixed(4)}%)`,
  );
});

check("LEGACY: guidance WITHOUT pins still models the live odds (unchanged arm)", () => {
  const g = bidoofGuidance(false);
  const liveEv = BIDOOF.values.reduce(
    (a, v, i) => a + (BIDOOF.liveWeights[i]! / 1e6) * v,
    0,
  );
  assert(
    Math.abs(g.feasibility.evMin - liveEv) < 1e-9 &&
      Math.abs(g.feasibility.evMax - liveEv) < 1e-9,
    `no-pins interval must stay the live point ${liveEv.toFixed(4)} (got [${g.feasibility.evMin.toFixed(4)}, ${g.feasibility.evMax.toFixed(4)}])`,
  );
  const s = g.suggestions.find((x) => x.kind === "price-edge-exact");
  assert(s !== undefined, "the live-arm fix is still emitted");
});

// ── 8. PINS-AWARE UNTAGGED GUIDANCE (retune V3) ─────────────────────────
//
// `computeUntaggedGuidance` gets the same pins treatment the tagged advisor
// got: owner pins ride every window as fixed point-masses, the verification
// solves hold them, and an owner-pinned share is NEVER mistaken for the
// quantizer's 0.0001% floor-pin signature (owner intent ≠ dead card).
// Fixture: the CAPTIVE pool — its degenerate plan floor-pins the $33.95
// card, which the legacy guidance flags as remove-dead-card.

const CAPTIVE = {
  price: 485.5,
  values: [9100, 3247.24, 2040, 1080, 635.14, 80.28, 33.95, 18.23],
  livePcts: [0.5, 4, 5, 7, 8.5, 15, 20, 40],
};
const captiveW = CAPTIVE.livePcts.map((p) => Math.round(p * 10000));
const captiveB = computePackRisk({
  cards: CAPTIVE.values.map((v, i) => ({ value: v, weight: captiveW[i]! })),
  price: CAPTIVE.price,
});
const captiveT = autoRetuneTargets(
  CAPTIVE.price,
  MASAKI_CFG,
  undefined,
  Math.max(...CAPTIVE.values),
  {
    winRate: captiveB.winRate,
    nearMiss: captiveB.nearMiss,
    edge: captiveB.edge,
    topValue: Math.max(...CAPTIVE.values),
  },
);
const captiveSearch = searchBestPriceForCleanSnap({
  cards: CAPTIVE.values.map((v) => ({ value: v })),
  basePrice: CAPTIVE.price,
  targetEdge: captiveT.targetEdge,
  targetWinRate: captiveT.targetWinRate,
  maxWinCap: captiveT.maxWinCap,
  nearMissMin: captiveT.nearMissMin,
  winRateTol: 0.02,
  currentWeights: captiveW,
  maxPriceChangePct: RETUNE_PRICE_BUDGET_DEFAULT_PCT,
  upwardPriceExtensionPct: 0,
  disperseLoss: true,
  holdWinRate: true,
});
const captivePlan = assertSuccess(captiveSearch.bestResult, "captive plan");
const captiveTotal = captivePlan.weights.reduce(
  (a, w) => a + (Number.isFinite(w) && w > 0 ? w : 0),
  0,
);
const captivePlanned = captivePlan.weights.map((w) =>
  w > 0 ? w / captiveTotal : 0,
);
const captiveGInput = {
  cards: CAPTIVE.values.map((v) => ({ value: v })),
  currentWeights: captiveW,
  cardIds: CAPTIVE.values.map((_, i) => `c${i}`),
  livePrice: CAPTIVE.price,
  price: captiveSearch.bestPrice,
  targetEdge: captiveT.targetEdge,
  targetWinRate: captiveT.targetWinRate,
  nearMissMin: captiveT.nearMissMin,
  maxWinCap: captiveT.maxWinCap,
  plannedShares: captivePlanned,
  relaxations: [],
  shapeDegenerate: true,
};

check("untagged guidance: empty pinnedShares ≡ omitted (byte-identical JSON)", () => {
  const a = computeUntaggedGuidance(captiveGInput);
  const b = computeUntaggedGuidance({ ...captiveGInput, pinnedShares: [] });
  assert(a !== null && b !== null, "guidance fires on the degenerate captive plan");
  assert(JSON.stringify(a) === JSON.stringify(b), "the legacy arm must be byte-identical");
});

check("untagged guidance: an owner pin at the floor share is INTENT, not a dead card (remove-dead-card flips off)", () => {
  const g0 = computeUntaggedGuidance(captiveGInput);
  assert(g0 !== null, "guidance fires without pins");
  const dead0 = g0.suggestions.filter((s) => s.kind === "remove-dead-card");
  assert(
    dead0.length === 1 && dead0[0]!.params.cardId === "c6",
    `legacy arm flags the floor-pinned $33.95 (got ${JSON.stringify(dead0.map((d) => d.params.cardId))})`,
  );
  // The owner pins the SAME card at the SAME floor share — now it's intent.
  const gPin = computeUntaggedGuidance({
    ...captiveGInput,
    pinnedShares: [{ index: 6, share: captivePlanned[6]! }],
  });
  assert(gPin !== null, "guidance still fires with the pin");
  assert(
    !gPin.suggestions.some((s) => s.kind === "remove-dead-card"),
    "an owner-pinned card is never a remove-dead-card candidate",
  );
});

check("untagged guidance: the add-card fix verifies WITH the pin held (re-applied through the solver)", () => {
  const pin = { index: 6, share: captivePlanned[6]! };
  const gPin = computeUntaggedGuidance({
    ...captiveGInput,
    pinnedShares: [pin],
  });
  assert(gPin !== null, "guidance fires");
  const add = gPin.suggestions.find((s) => s.kind === "add-card");
  assert(add !== undefined, "the pool-edit fix is emitted under the pin");
  assert(add.proof.solverVerified === true, "…and is solver-verified WITH the pin");
  const rt = assertSuccess(
    shapeWeights({
      cards: [
        ...CAPTIVE.values.map((v) => ({ value: v })),
        { value: Number(add.params.suggestedValue) },
      ],
      price: Number(add.params.price),
      targetEdge: captiveT.targetEdge,
      targetWinRate: captiveT.targetWinRate,
      maxWinCap: captiveT.maxWinCap,
      nearMissMin: captiveT.nearMissMin,
      winRateTol: 0.02,
      currentWeights: [...captiveW, 0],
      pinnedShares: [{ ...pin }],
    }),
    "re-apply the add-card fix with the pin",
  );
  const held = shareOf(rt.weights, 6);
  assert(
    Math.abs(held - pin.share) <= 1e-9,
    `the pin must hold through the applied fix (got ${held} vs ${pin.share})`,
  );
  assert(rt.edge >= captiveT.targetEdge - 1e-9, "edge ≥ target under the applied fix");
});

check("untagged guidance: a pinned carrier is a fixed point-mass — the feasibility window squeezes INWARD", () => {
  const g0 = computeUntaggedGuidance(captiveGInput)!;
  // Pin the $80.28 dust carrier at 30%: 24.08 of EV becomes fixed; both
  // bounds must move toward it (the freedom the carrier provided is gone).
  const gPin = computeUntaggedGuidance({
    ...captiveGInput,
    pinnedShares: [{ index: 5, share: 0.3 }],
  })!;
  assert(gPin !== null, "guidance fires with the carrier pin");
  assert(
    gPin.feasibility.evMin > g0.feasibility.evMin + 1,
    `evMin must rise (fixed 24.08 EV floor): ${g0.feasibility.evMin.toFixed(3)} → ${gPin.feasibility.evMin.toFixed(3)}`,
  );
  assert(
    gPin.feasibility.evMax < g0.feasibility.evMax - 1,
    `evMax must fall (the carrier can't absorb upward anymore): ${g0.feasibility.evMax.toFixed(3)} → ${gPin.feasibility.evMax.toFixed(3)}`,
  );
  assert(
    gPin.feasibility.evMin <= gPin.feasibility.evMax + 1e-9,
    "the window stays a window",
  );
});

// ── Summary ─────────────────────────────────────────────────────────────
console.log(
  `\n${passes} passed, ${failures.length} failed${
    failures.length > 0 ? ` — ${failures.join(", ")}` : ""
  }`,
);
if (failures.length > 0) process.exit(1);
