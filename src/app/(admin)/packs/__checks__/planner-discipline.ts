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
  enforceLossMonotone,
  findMonotoneViolations,
  RETUNE_PRICE_BUDGET_DEFAULT_PCT,
  RETUNE_MAX_PRICE_CHANGE_PCT,
  WINRATE_HOLD_BAND,
} from "../../insights/edge-calc/risk";
import {
  ladderShape,
  LADDER_DEGENERATE_THRESHOLD,
  buildWidePriceProbeSuggestion,
  derivePoolEditPlan,
  isFloorPinnedPct,
  type ProbeOutcome,
  type TagGuidance,
} from "../../insights/edge-calc/tag-guidance";
import { buildRetuneSearchParams } from "../_lib/retune-params";
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

// ── Win-rate HOLD fixtures (owner-lens item 4) — untagged floaters ────────
// Two of these were the named DEAD-ENDS (monotone ladders the shape guard
// misses, guidance returns null): the float used to push their achieved
// win-rate far above the live-anchored design (Three Blades 30.0%→37.5%, Trash
// 33.2%→40.2%). The HOLD caps the untagged float at design + WINRATE_HOLD_BAND
// (+5pp); a price where the held win-rate can't reach the edge errors and the
// search moves to one where it can (a clean plan) — Three Blades gains a clean
// in-band plan via the soft fallback; Trash (Retune V3) gains an in-band plan
// via the LAW M rescue ladder at the live price with the design rate held
// EXACT. All are untagged (`tag: null`), snapshots from the fleet dump
// (values + live weights).
const THREE_BLADES: Pool = {
  name: "Three Blades",
  price: 113.5,
  values: [2600, 987.06, 764.51, 323.8, 244.57, 126.37, 80.72, 12.55],
  livePcts: [0.05, 0.5, 0.75, 3.5, 11.2, 14, 35, 35],
  tag: null,
};
const TRASH: Pool = {
  name: "Trash",
  price: 0.15,
  values: [306, 25.16, 1.56, 1.25, 0.8, 0.52, 0.35, 0.23, 0.18, 0.08, 0.01],
  livePcts: [0.005, 0.02, 0.245, 0.25, 0.8, 1.65, 8.03, 10, 12.2, 16.8, 50],
  tag: null,
};
const PROFIT_NINJA: Pool = {
  name: "Profit Ninja",
  price: 65.25,
  values: [1199.99, 332.28, 233.99, 71.28, 59.7, 39.19, 24.74, 20.34, 0.3],
  livePcts: [2, 1, 1, 8, 13, 15, 20, 20, 20],
  tag: null,
};
const SNACK_TIME: Pool = {
  name: "Snack Time",
  price: 0.45,
  values: [12.32, 7.55, 4.54, 2.28, 1.52, 0.96, 0.78, 0.5, 0.02],
  livePcts: [0.5, 0.75, 1, 1.25, 2.5, 4, 6.6, 13.4, 70],
  tag: null,
};

function toWeights(pcts: number[]): number[] {
  return pcts.map((p) => Math.round(p * 10000));
}
function toShares(pcts: number[]): number[] {
  return pcts.map((p) => p / 100);
}

/**
 * Run the EXACT live-arm solve `planPackTuneLiveUncached` runs, at `band`.
 * `disperse` (default true, mirroring the real retune) toggles the loss-mass
 * dispersion pass — set false to inspect the RAW fixed-pool layout the shape
 * guard classifies BEFORE the dispersion fix.
 */
function solve(p: Pool, band: number, disperse = true) {
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
    ...(disperse ? { disperseLoss: true } : {}),
    ...(p.tag !== null ? { taggedWinRate: t.targetWinRate } : { holdWinRate: true }),
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

/**
 * The live-anchored target win-rate + the ACHIEVED (post-solve) win-rate for an
 * untagged pack at `band` — the two numbers the win-rate HOLD check pins.
 * `feasible` is false when the held solve can't reach the edge at any in-band
 * price (the pack becomes a pool-edit / wide-probe path — exempt from the
 * hold-window check, which only governs FEASIBLE plans).
 */
function solveHold(p: Pool, band: number): {
  targetWinRate: number;
  achievedWinRate: number | null;
  feasible: boolean;
  price: number | null;
} {
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
  const out = solve(p, band);
  if (out.price === null || out.planned === null) {
    return { targetWinRate: t.targetWinRate, achievedWinRate: null, feasible: false, price: null };
  }
  const after = computePackRisk({
    cards: p.values.map((v, i) => ({ value: v, weight: (out.r as { weights: number[] }).weights[i]! })),
    price: out.price,
  });
  return {
    targetWinRate: t.targetWinRate,
    achievedWinRate: after.winRate,
    feasible: true,
    price: out.price,
  };
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

// ── 2. Tails? (complaint B) — RAW crush is DEGENERATE; dispersion FIXES it ─
check("Tails? ±10%: the RAW fixed-pool layout is DEGENERATE (loss ladder inverted, carrier absorbs)", () => {
  // Without the dispersion pass, the shape guard must classify complaint B's
  // crush ladder DEGENERATE — the guard's teeth on the raw layout.
  const out = solve(TAILS, RETUNE_PRICE_BUDGET_DEFAULT_PCT, /* disperse */ false);
  assert(out.price !== null, "Tails? ±10% must be feasible");
  const s = shapeOf(TAILS, out.planned!, out.price!);
  assert(s.lossInvArea >= 0.1, `loss ladder is inverted (lossInvArea ${s.lossInvArea})`);
  assert(s.absorberExcess >= 0.25, `a carrier absorbs the loss mass (+${(s.absorberExcess * 100).toFixed(1)}pp)`);
  assert(s.degenerate, `complaint B's raw layout is DEGENERATE (score ${s.score})`);
});

check("Tails? ±10%: loss-mass DISPERSION turns complaint B HEALTHY (the fix), edge held ≥ live", () => {
  // With dispersion (the real retune path), complaint B's loss mass spreads off
  // the $194.10 carrier and the ladder reads HEALTHY (< 0.25) — the crush was a
  // layout artifact, not EV-forced. The edge is never refunded below live.
  const raw = solve(TAILS, RETUNE_PRICE_BUDGET_DEFAULT_PCT, false);
  const fixed = solve(TAILS, RETUNE_PRICE_BUDGET_DEFAULT_PCT, true);
  assert(raw.price !== null && fixed.price !== null, "Tails? feasible both ways");
  const sRaw = shapeOf(TAILS, raw.planned!, raw.price!);
  const sFixed = shapeOf(TAILS, fixed.planned!, fixed.price!);
  assert(sRaw.degenerate, "the raw layout is degenerate");
  assert(
    !sFixed.degenerate && sFixed.score < LADDER_DEGENERATE_THRESHOLD,
    `dispersion makes complaint B healthy (score ${sRaw.score.toFixed(2)} → ${sFixed.score.toFixed(2)})`,
  );
  const beforeTails = computePackRisk({
    cards: TAILS.values.map((v, i) => ({ value: v, weight: toWeights(TAILS.livePcts)[i]! })),
    price: TAILS.price,
  });
  const afterTails = computePackRisk({
    cards: TAILS.values.map((v, i) => ({ value: v, weight: (fixed.r as { weights: number[] }).weights[i]! })),
    price: fixed.price!,
  });
  assert(
    afterTails.edge >= beforeTails.edge - 0.0006 - 1e-9,
    `dispersion never drops edge below live (${(afterTails.edge * 100).toFixed(3)}% vs live ${(beforeTails.edge * 100).toFixed(3)}%)`,
  );
});

// ── 2b. DISPERSE path never emits an ASCENDING loss band (owner rule) ─────
// The disperse path was the culprit in the "10% Divine Order" scramble: the
// affine min-L2 loss re-spread slopes UP in value (b>0) when the required loss
// mean sits above the band's uniform mean, producing a rich loss card likelier
// than a cheaper one. The engine now enforces the loss-monotone invariant on the
// FINAL vector (buffer exempt), so EVERY disperse-path plan reads monotone or is
// refused — never shipped ascending.
function bufExemptLossViol(values: number[], weights: number[], price: number): number {
  const total = weights.reduce((a, b) => a + (b > 0 ? b : 0), 0);
  if (!(total > 0)) return 0;
  const loss = values.map((v, i) => ({ v, w: weights[i]! })).filter((x) => x.v > 0 && x.v < price && x.w > 0);
  if (loss.length < 2) return 0;
  let buf = 0;
  for (let k = 1; k < loss.length; k++) {
    if (loss[k]!.w > loss[buf]!.w || (loss[k]!.w === loss[buf]!.w && loss[k]!.v < loss[buf]!.v)) buf = k;
  }
  const chain = loss.filter((_, k) => k !== buf).sort((a, b) => a.v - b.v);
  let viol = 0;
  for (let k = 0; k + 1 < chain.length; k++) if (chain[k]!.w < chain[k + 1]!.w - 1e-9) viol += 1;
  return viol;
}

check("loss-monotone: the DISPERSE path never ships an ascending loss band (fleet, both bands)", () => {
  const fleet = [CHAOS, TAILS, CAPTIVE, BIDOOF, HEAVY_HITTERS, THREE_BLADES, TRASH, PROFIT_NINJA, SNACK_TIME];
  for (const p of fleet) {
    for (const band of [RETUNE_PRICE_BUDGET_DEFAULT_PCT, RETUNE_MAX_PRICE_CHANGE_PCT]) {
      const out = solve(p, band, true);
      if (out.price === null || out.planned === null) continue; // refused = honest (no plan)
      const weights = (out.r as { weights: number[] }).weights;
      const viol = bufExemptLossViol(p.values, weights, out.price);
      assert(viol === 0, `${p.name}@±${(band * 100).toFixed(0)}%: shipped ${viol} loss inversion(s)`);
    }
  }
});

check("enforceLossMonotone: EV-forced ascending band (no monotone layout) is refused, not shipped", () => {
  // A synthetic loss band with a real inversion in the non-buffer chain: the
  // ascending scramble the affine dispersion produces. With the buffer being the
  // argmax ($40 at 500), the remaining chain [10:1, 20:5, 30:50] ASCENDS in
  // value → an inversion the enforce must repair (mass held) or refuse.
  const values = [10, 20, 30, 40];
  const inverted = [1, 5, 50, 500]; // chain 10:1 20:5 30:50 ascends → inversion, buffer=40
  const before = bufExemptLossViol(values, inverted, 1000);
  assert(before > 0, "the synthetic band starts non-monotone");
  const res = enforceLossMonotone({ values, weights: inverted, price: 1000 });
  // Either a valid repair (monotone, mass held) OR an honest refusal — never
  // returns the ascending input as "ok + unchanged".
  if (res.ok && res.changed) {
    assert(bufExemptLossViol(values, res.weights, 1000) === 0, "a repair must be monotone");
    const m0 = inverted.reduce((a, b) => a + b, 0);
    const m1 = res.weights.reduce((a, b) => a + b, 0);
    assert(m0 === m1, `mass held (${m0} vs ${m1})`);
  } else {
    assert(!res.ok, "an unrepairable band is flagged ok:false, never silently shipped");
  }
});

// ── 3. Captive — the old floor-pin crush is GONE under LAW M ─────────────
check("Captive ±10%: HEALTHY under LAW M — the old $33.95/$18.23 floor-pin crush was never EV-forced", () => {
  // Pre-V3 this pack shipped its two cheapest loss cards at the 0.0001%
  // floor (the owner's complaint) and the shape guard read DEGENERATE. The
  // LAW M gate refuses those zigzag layouts, which steers the price search
  // to a cent where the hard-held solve lands a LAWFUL ladder — snapped,
  // healthy, and with both former floor pins carrying REAL mass (≈20% and
  // ≈54%). The "EV-forced crush" story was a solver artifact, not physics.
  const out = solve(CAPTIVE, RETUNE_PRICE_BUDGET_DEFAULT_PCT);
  assert(out.price !== null, "Captive ±10% must be feasible");
  const s = shapeOf(CAPTIVE, out.planned!, out.price!);
  assert(s.crushedCount === 0, `no crushed cards under LAW M (got ${s.crushedCount})`);
  assert(!s.degenerate && s.score < LADDER_DEGENERATE_THRESHOLD, `healthy (score ${s.score})`);
  // The two formerly-crushed cheapest loss cards carry real, lawful mass.
  assert(
    out.planned![6]! > 0.05 && out.planned![7]! > 0.2,
    `the $33.95/$18.23 cards carry real mass (got ${(out.planned![6]! * 100).toFixed(3)}% / ${(out.planned![7]! * 100).toFixed(3)}%)`,
  );
  // And the full ladder is LAW-M-clean.
  assert(
    findMonotoneViolations({ values: CAPTIVE.values, shares: out.planned! }).length === 0,
    "the shipped plan obeys LAW M end to end",
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

// ── 5b. WIN-RATE HOLD (owner-lens item 4) — untagged float capped at design+band ─
check("win-rate hold: WINRATE_HOLD_BAND is 0.05 (+5pp)", () => {
  assert(
    Math.abs(WINRATE_HOLD_BAND - 0.05) < 1e-12,
    `the hold band must be +5pp (got ${WINRATE_HOLD_BAND})`,
  );
});

check("win-rate hold: EVERY feasible untagged plan lands within +5pp of its design (Three Blades, Profit Ninja, Snack Time)", () => {
  // The findings' executable check: |after.winRate − target| ≤ 0.05 for every
  // untagged FEASIBLE plan. Three Blades was the named dead-end (30.0%→37.5%
  // before the hold — a monotone ladder the shape guard misses). The float now
  // holds inside the band. Trash is the OTHER named dead-end; it has no in-band
  // held price (checked separately below) so it is exempt here.
  for (const p of [THREE_BLADES, PROFIT_NINJA, SNACK_TIME]) {
    const h = solveHold(p, RETUNE_PRICE_BUDGET_DEFAULT_PCT);
    if (!h.feasible) continue; // an infeasible pack is a pool-edit path, not a floated plan
    // The findings' executable check: |after.winRate − target| ≤ 0.05. The float
    // is one-sided UP (the target is the design floor), so the interesting bound
    // is the +band ceiling; the lower side only ever moves by snap/quantization
    // noise (≤ 0.1pp), well inside the two-sided window.
    assert(
      Math.abs(h.achievedWinRate! - h.targetWinRate) <= WINRATE_HOLD_BAND + 1e-6,
      `${p.name}: achieved ${(h.achievedWinRate! * 100).toFixed(2)}% must land within ±${(WINRATE_HOLD_BAND * 100).toFixed(0)}pp of design ${(h.targetWinRate * 100).toFixed(2)}%`,
    );
    // And the hold NEVER floats the win-rate DOWN meaningfully — the design rate
    // is the floor (only snap rounding of ≤ 0.1pp may dip below it).
    assert(
      h.achievedWinRate! >= h.targetWinRate - 0.001,
      `${p.name}: the design win-rate is the FLOOR (got ${(h.achievedWinRate! * 100).toFixed(3)}% vs ${(h.targetWinRate * 100).toFixed(3)}%)`,
    );
  }
});

check("win-rate hold: Three Blades — the named dead-end gains a CLEAN in-band plan (was 30%→37.5%)", () => {
  // Before the hold Three Blades floated to 37.5% (a +7.5pp rewrite of its
  // designed 30% win-rate) at the live price. The hold caps the float; the price
  // search moves the ticket a few cents to a price where the band-held win-rate
  // reaches the edge — a clean, in-band plan with ZERO pathless residual.
  const h = solveHold(THREE_BLADES, RETUNE_PRICE_BUDGET_DEFAULT_PCT);
  assert(h.feasible, "Three Blades must gain a feasible in-band plan (not a dead-end)");
  assert(
    h.achievedWinRate! <= h.targetWinRate + WINRATE_HOLD_BAND + 1e-6,
    `held within band (got ${(h.achievedWinRate! * 100).toFixed(2)}%, design ${(h.targetWinRate * 100).toFixed(2)}%)`,
  );
  // Concretely the achieved win-rate is well below the pre-hold 37.5% float.
  assert(
    h.achievedWinRate! < 0.355,
    `the float is suppressed below the old 37.5% (got ${(h.achievedWinRate! * 100).toFixed(2)}%)`,
  );
});

check("win-rate hold: Trash — the LAW M rescue ladder plans it IN-BAND at the held design rate (old dead-end gone)", () => {
  // Pre-V3 Trash was the named dead-end: the core split (near-miss floor as
  // an EXACT allocation) left the edge unreachable at every ±10% price. The
  // lawful window treats the floor as a FLOOR — the rescue lays a LAW-M
  // ladder at the live price with the design rate held EXACT (33.20%), all
  // 11 rows alive. The wide band stays feasible too.
  const def = solveHold(TRASH, RETUNE_PRICE_BUDGET_DEFAULT_PCT);
  assert(def.feasible, "Trash gains an in-band held plan (the rescue ladder)");
  assert(
    Math.abs(def.achievedWinRate! - def.targetWinRate) <= 1e-4,
    `the design rate is held EXACT (got ${(def.achievedWinRate! * 100).toFixed(3)}% vs ${(def.targetWinRate * 100).toFixed(3)}%)`,
  );
  const wide = solve(TRASH, RETUNE_MAX_PRICE_CHANGE_PCT);
  assert(
    wide.price !== null,
    "Trash stays feasible at ±60% too",
  );
});

check("win-rate hold: does NOT fire on TAGGED packs (Chaos/Bidoof keep their exact tag)", () => {
  // The hold is untagged-only (a tagged pack never floats — the tag pins the
  // win-rate). Chaos (10% tag) and Bidoof (1% tag) must still land ON their tag,
  // untouched by the hold band.
  for (const p of [CHAOS, BIDOOF]) {
    const h = solveHold(p, RETUNE_PRICE_BUDGET_DEFAULT_PCT);
    if (!h.feasible) continue;
    assert(
      Math.abs(h.achievedWinRate! - p.tag!) <= 1e-3,
      `${p.name}: tagged win-rate holds at the exact ${(p.tag! * 100).toFixed(0)}% tag (got ${(h.achievedWinRate! * 100).toFixed(3)}%)`,
    );
  }
});

// ── 5b-2. HARD hold WITH GRACEFUL SOFT FALLBACK (attempt #2) — real one-brain
// wiring via `buildRetuneSearchParams`, not the raw `holdWinRate` the `solve()`
// helper above passes directly. This exercises the ACTUAL untagged retune arm
// end-to-end: hard hold tried first, soft float only as a fallback when the
// hard hold is infeasible everywhere in-budget. ─────────────────────────────
function solveViaBuilder(p: Pool, band: number) {
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
  const nearMissMin = p.tag !== null ? Math.max(0, before.nearMiss) : t.nearMissMin;
  const search = searchBestPriceForCleanSnap(
    buildRetuneSearchParams("live", {
      cards: p.values.map((v) => ({ value: v })),
      basePrice: p.price,
      targetEdge: t.targetEdge,
      targetWinRate: t.targetWinRate,
      maxWinCap: t.maxWinCap,
      nearMissMin,
      winRateTol: 0.02,
      currentWeights: weights,
      intendedHitRate: p.tag,
      priceBudgetPct: band,
    }),
  );
  return { search, targetWinRate: t.targetWinRate };
}

check("HARD hold (via buildRetuneSearchParams): Three Blades — the default ±10% band falls back to SOFT (hard alone can't hold in-budget), still lands a CLEAN plan (never a bare refusal)", () => {
  const { search, targetWinRate } = solveViaBuilder(THREE_BLADES, RETUNE_PRICE_BUDGET_DEFAULT_PCT);
  const r = search.bestResult;
  assert("weights" in r, `Three Blades ±10% must plan via the fallback: ${"error" in r ? r.error : ""}`);
  assert(search.usedSoftFallback === true, "the hard hold alone can't hold in-budget here — the soft fallback fired");
  assert(
    (r as { risk: { winRate: number } }).risk.winRate <= targetWinRate + WINRATE_HOLD_BAND + 1e-6,
    "the FALLBACK soft float still respects its own +5pp band (unchanged legacy behavior)",
  );
  const total = (r as { weights: number[] }).weights.reduce((a, w) => a + (w > 0 ? w : 0), 0);
  const shares = (r as { weights: number[] }).weights.map((w) => (total > 0 && w > 0 ? w / total : 0));
  const pinned = THREE_BLADES.values.filter(
    (v, i) => v < search.bestPrice && isFloorPinnedPct(shares[i]! * 100),
  );
  assert(pinned.length === 0, `no 0.0001% floor-pinned cards survive the fallback plan (got ${JSON.stringify(pinned)})`);
});

check("HARD hold (via buildRetuneSearchParams): Trash — the ±10% band now plans via the LAW M rescue (design rate EXACT, no fallback, no floor pins); ±60% solves cleanly too", () => {
  // Pre-V3 the default band was an honest refusal (the old regression
  // floor). The LAW M rescue ladder turned it into a plan at the LIVE price:
  // win rate exactly the design (not a soft float — usedSoftFallback stays
  // FALSE), every row alive, ladder lawful end to end.
  const atDefault = solveViaBuilder(TRASH, RETUNE_PRICE_BUDGET_DEFAULT_PCT);
  const rd = atDefault.search.bestResult;
  assert("weights" in rd, `Trash's default ±10% band plans via the rescue: ${"error" in rd ? rd.error : ""}`);
  assert(
    atDefault.search.usedSoftFallback === false,
    "the rescue holds the DESIGN rate exactly — it reports as the hard arm, never a soft float",
  );
  const totalD = (rd as { weights: number[] }).weights.reduce((a, w) => a + (w > 0 ? w : 0), 0);
  const sharesD = (rd as { weights: number[] }).weights.map((w) => (totalD > 0 && w > 0 ? w / totalD : 0));
  const afterD = computePackRisk({
    cards: TRASH.values.map((v, i) => ({ value: v, weight: (rd as { weights: number[] }).weights[i]! })),
    price: atDefault.search.bestPrice,
  });
  assert(
    Math.abs(afterD.winRate - atDefault.targetWinRate) <= 1e-4,
    `design rate held EXACT (got ${(afterD.winRate * 100).toFixed(3)}%)`,
  );
  const pinnedD = TRASH.values.filter(
    (v, i) => v < atDefault.search.bestPrice && isFloorPinnedPct(sharesD[i]! * 100),
  );
  assert(pinnedD.length === 0, `no 0.0001% floor-pinned cards on the rescue plan (got ${JSON.stringify(pinnedD)})`);

  const atWide = solveViaBuilder(TRASH, RETUNE_MAX_PRICE_CHANGE_PCT);
  const r = atWide.search.bestResult;
  assert("weights" in r, `Trash's ±60% wide band must plan: ${"error" in r ? r.error : ""}`);
  assert(
    atWide.search.usedSoftFallback === false,
    "the HARD hold succeeds on its own at the wide band — strictly better than the old float (no fallback needed)",
  );
  const total = (r as { weights: number[] }).weights.reduce((a, w) => a + (w > 0 ? w : 0), 0);
  const shares = (r as { weights: number[] }).weights.map((w) => (total > 0 && w > 0 ? w / total : 0));
  const pinned = TRASH.values.filter(
    (v, i) => v < atWide.search.bestPrice && isFloorPinnedPct(shares[i]! * 100),
  );
  assert(pinned.length === 0, `no 0.0001% floor-pinned cards on the clean wide-band plan (got ${JSON.stringify(pinned)})`);
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

// ── 8. Pool-edits-first derivation (owner-lens §3) ──────────────────────
function guidanceWith(suggestions: TagGuidance["suggestions"]): TagGuidance {
  return {
    feasibility: {
      evTarget: 0,
      evMin: 0,
      evMax: 0,
      feasible: true,
      saturated: false,
      direction: "ok",
      components: { winEvMin: 0, winEvMax: 0, nmMass: 0, dustMass: 0, capSum: 0 },
    },
    suggestions,
  };
}
const PROOF = { evMinAfter: 0, evMaxAfter: 0, feasibleAfter: true, solverVerified: true };

check("pool-edit: derived from an add-card + remove-dead-card + price-move guidance", () => {
  const g = guidanceWith([
    {
      kind: "add-card",
      params: { band: "near-miss", valueMin: 281.79, valueMax: 327.39, suggestedValue: 310.16, expectedShare: 0.1 },
      humanCopy: "",
      proof: PROOF,
    },
    { kind: "remove-dead-card", params: { cardId: "c-3395", cardValue: 33.95 }, humanCopy: "", proof: PROOF },
    { kind: "remove-dead-card", params: { cardId: "c-1823", cardValue: 18.23 }, humanCopy: "", proof: PROOF },
    { kind: "price-move", params: { price: 344.62 }, humanCopy: "", proof: PROOF },
  ]);
  const pe = derivePoolEditPlan(g, "degenerate-shape", 485.5, 0.1);
  assert(pe !== null, "an actionable pool lever → a poolEditPlan");
  assert(pe!.reason === "degenerate-shape", "reason threaded");
  assert(pe!.addCard !== null && pe!.addCard.suggestedValue === 310.16, "add-card carried verbatim");
  assert(pe!.addCard!.expectedShare === 0.1, "expectedShare carried");
  assert(
    pe!.removeCardIds.length === 2 &&
      pe!.removeCardIds.includes("c-3395") &&
      pe!.removeCardIds.includes("c-1823"),
    "both dead cards collected",
  );
  assert(pe!.price === 344.62, "price from the price-move suggestion");
  assert(pe!.beyondBudget === true, "$344.62 is >10% below $485.50 → beyond budget");
  assert(pe!.solverVerified === true, "guidance suggestions are solver-round-tripped");
});

check("pool-edit: a pure-removal fix (no add-card) still derives", () => {
  const g = guidanceWith([
    { kind: "remove-dead-card", params: { cardId: "c-dead", cardValue: 5 }, humanCopy: "", proof: PROOF },
  ]);
  const pe = derivePoolEditPlan(g, "infeasible", 100, 0.1);
  assert(pe !== null, "a removal-only fix is still a poolEditPlan");
  assert(pe!.addCard === null, "no add-card lever");
  assert(pe!.removeCardIds.length === 1, "the dead card is collected");
  assert(pe!.price === null, "no price suggestion → null price");
  assert(pe!.beyondBudget === false, "no price → not beyond budget");
});

check("pool-edit: an in-budget price → beyondBudget false; a healthy guidance → null", () => {
  const inBudget = derivePoolEditPlan(
    guidanceWith([
      { kind: "add-card", params: { band: "dust", valueMin: 1, valueMax: 2, suggestedValue: 1.5, expectedShare: 0.05 }, humanCopy: "", proof: PROOF },
      { kind: "price-move", params: { price: 105 }, humanCopy: "", proof: PROOF },
    ]),
    "degenerate-shape",
    100,
    0.1,
  );
  assert(inBudget !== null && inBudget.beyondBudget === false, "$105 within ±10% of $100 → in budget");
  // No actionable lever (only accept-as-is / price) → null (falls back to banner).
  const noLever = derivePoolEditPlan(
    guidanceWith([{ kind: "accept-as-is", params: {}, humanCopy: "", proof: PROOF }]),
    "degenerate-shape",
    100,
    0.1,
  );
  assert(noLever === null, "no add/remove lever → null (banner fallback)");
  // Null guidance → null.
  assert(derivePoolEditPlan(null, "infeasible", 100, 0.1) === null, "null guidance → null");
});

// ── Summary ─────────────────────────────────────────────────────────────
console.log(
  `\n${passes} passed, ${failures.length} failed${
    failures.length > 0 ? ` — ${failures.join(", ")}` : ""
  }`,
);
if (failures.length > 0) process.exit(1);
