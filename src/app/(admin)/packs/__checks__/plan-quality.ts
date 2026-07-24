/**
 * PLAN-QUALITY harness — the owner's judgment as CODE (owner-lens fleet review).
 *
 * Run with:
 *   npx tsx "src/app/(admin)/packs/__checks__/plan-quality.ts"
 *
 * NO DB, NO React, NO server imports — pure engine math + pure copy functions on
 * inlined fleet-pool fixtures (values + live weights are data snapshots, the same
 * practice as the niceness / planner-discipline harnesses). This suite encodes
 * EVERY executable check from the owner-lens fleet review (all 11 defect
 * patterns) so a re-tune of the planner can never silently regress the owner's
 * standards. It runs forever alongside the other packs/__checks__ suites.
 *
 * Each pattern's check mirrors its findings-document spec. Where a fix has landed
 * (Waves 1 + 2) the check is GREEN; the pin is the CONTRACT (which invariant
 * holds), not a transient number — every expected value is re-derived here by
 * running the real engine, never trusted from the doc.
 *
 * Exit code 0 = all passed; 1 = at least one failure (printed).
 */

import {
  autoRetuneTargets,
  resolveIntendedHitRate,
  DEFAULT_TARGET_WIN_RATE,
  type ResolvedAutoTargetCfg,
} from "../_lib/auto-targets";
import {
  searchBestPriceForCleanSnap,
  shapeWeights,
  computePackRisk,
  snapWeightsToCleanLadder,
  disperseLossBand,
  preserveNearMissLossLayout,
  enforceLossMonotone,
  findMonotoneViolations,
  taggedPlanNodeBudget,
  RETUNE_PRICE_BUDGET_DEFAULT_PCT,
  RETUNE_MAX_PRICE_CHANGE_PCT,
} from "../../insights/edge-calc/risk";
import {
  ladderShape,
  computeUntaggedGuidance,
  derivePoolEditPlan,
  pruneNoOpSuggestions,
  type TagGuidance,
} from "../../insights/edge-calc/tag-guidance";
import { packRiskBand, isRiskBandExit } from "../_lib/risk-bands";
import {
  relaxationLine,
  dirtyOddsBanner,
  poolEditSummary,
  STATUS_BADGE,
} from "../../../(pack-studio)/pack-studio/retune/_workspace/plan-copy";

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

// ── Fixture pools (fleet dump snapshots) ─────────────────────────────────
type Pool = {
  name: string;
  price: number;
  values: number[];
  livePcts: number[];
  tag: number | null;
  tags?: string[];
};

// Complaint-class fixtures (also in planner-discipline.ts — same snapshots).
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

// ── Loss-mass DISPERSION fixtures (owner-lens item 10) — crush ladders ────
// Untagged packs whose fixed-pool default plan CRUSHES a live-≥5% loss card to
// the quantization floor while one carrier absorbs the loss mass (a crush
// ladder). The dispersion pass re-spreads the loss band at the SAME mass + EV,
// so these become HEALTHY (shape < 0.25) after dispersion — the crush is a
// LAYOUT artifact here, not EV-forced. Snapshots from the fleet dump.
const NINE_FIVE: Pool = {
  name: "9-5",
  price: 4.61,
  values: [195.85, 107.1, 51.34, 41.15, 33, 26.23, 12.2, 11.03, 7.15, 5.14, 2.44, 0.59, 0.05],
  livePcts: [0.1, 0.25, 0.5, 0.75, 1, 2, 3.5, 5, 7, 9.9, 5, 15, 50],
  tag: null,
};
const BEST_FRIENDS: Pool = {
  name: "Best Friends",
  price: 1.44,
  values: [80.28, 43.45, 24.19, 11.57, 5.93, 2.32, 2.2, 1.96, 1.4, 0.84, 0.02],
  livePcts: [0.01, 0.25, 0.5, 1, 3, 6, 8, 9.8, 10, 11.44, 50],
  tag: null,
};
const HIGH_TIDES: Pool = {
  name: "High Tides",
  price: 262.4,
  values: [5000, 1191.96, 839.94, 491.32, 372.18, 194.1, 94.97, 57.35],
  livePcts: [0.5, 3.5, 3.8, 4.2, 8, 20, 30, 30],
  tag: null,
};

function toWeights(pcts: number[]): number[] {
  return pcts.map((p) => Math.round(p * 10000));
}
function toShares(pcts: number[]): number[] {
  return pcts.map((p) => p / 100);
}

type SolveOut = {
  price: number | null;
  planned: number[] | null;
  snapped: boolean | null;
  before: ReturnType<typeof computePackRisk>;
  after: ReturnType<typeof computePackRisk> | null;
  targets: ReturnType<typeof autoRetuneTargets>;
  fellBackToBase: boolean;
  weights: number[] | null;
};

/**
 * Run the EXACT live-arm solve `planPackTuneLiveUncached` runs, at `band`,
 * with a resolved intended hit-rate (DB tag or name) exactly as the plan does.
 */
function solve(p: Pool, band: number, disperse = true): SolveOut {
  const weights = toWeights(p.livePcts);
  const before = computePackRisk({
    cards: p.values.map((v, i) => ({ value: v, weight: weights[i]! })),
    price: p.price,
  });
  const top = Math.max(...p.values);
  const hitRate = resolveIntendedHitRate(p.name, p.tags ?? null) ?? p.tag ?? undefined;
  const t = autoRetuneTargets(p.price, CFG, hitRate ?? undefined, top, {
    winRate: before.winRate,
    nearMiss: before.nearMiss,
    edge: before.edge,
    topValue: top,
  });
  const tagged = t.intendedHitRate !== null;
  const nearMissMin = tagged ? Math.max(0, before.nearMiss) : t.nearMissMin;
  const search = searchBestPriceForCleanSnap({
    cards: p.values.map((v) => ({ value: v })),
    basePrice: p.price,
    targetEdge: t.targetEdge,
    targetWinRate: t.targetWinRate,
    maxWinCap: t.maxWinCap,
    nearMissMin,
    winRateTol: tagged ? 1e-4 : 0.02,
    currentWeights: weights,
    maxPriceChangePct: band,
    upwardPriceExtensionPct: 0,
    ...(disperse ? { disperseLoss: true } : {}),
    ...(tagged ? { taggedWinRate: t.targetWinRate } : { holdWinRate: true }),
  });
  const r = search.bestResult;
  if ("error" in r) {
    return {
      price: null,
      planned: null,
      snapped: null,
      before,
      after: null,
      targets: t,
      fellBackToBase: search.fellBackToBase,
      weights: null,
    };
  }
  const total = r.weights.reduce((a, x) => a + (x > 0 ? x : 0), 0);
  const planned = r.weights.map((x) => (total > 0 && x > 0 ? x / total : 0));
  const after = computePackRisk({
    cards: p.values.map((v, i) => ({ value: v, weight: r.weights[i]! })),
    price: search.bestPrice,
  });
  return {
    price: search.bestPrice,
    planned,
    snapped: r.snapped ?? false,
    before,
    after,
    targets: t,
    fellBackToBase: search.fellBackToBase,
    weights: r.weights.slice(),
  };
}

/**
 * For the P11 equal-value dust fixture [winner, dustA, dustB], identify which of
 * the two equal dust cards is the BUFFER (the residual absorber). The buffer
 * carries the exact residual (49.9875% = weight 499875); the non-buffer snapped
 * to the clean 50% rung (weight 500000). Returns 1 or 2, or -1 if the layout
 * doesn't match the fixture (a guard against a silent snap change).
 *
 * Residual re-derived after the clean-ladder densification (31368e2a added the
 * 6/7/8/9/12.5/60/70 mantissas): the winner's precise 0.01249844% used to be
 * pushed UP a full rung to 0.015% (buffer residual 100 − 50 − 0.015 = 49.985%);
 * the denser grid now offers 12.5e-3 = 0.0125%, so the winner snaps essentially
 * onto its own value and the buffer residual is 100 − 50 − 0.0125 = 49.9875%.
 * The LAW this helper serves — WHICH card absorbs the residual — is unchanged;
 * only the residual's magnitude moved, and it moved because the snap got MORE
 * faithful, not less.
 */
function bufferIndex(snap: { weights: number[] }): number {
  const w1 = snap.weights[1];
  const w2 = snap.weights[2];
  const isResidual = (w: number | undefined): boolean => w === 499875;
  if (isResidual(w1) && w2 === 500000) return 1;
  if (isResidual(w2) && w1 === 500000) return 2;
  return -1;
}

/** Live and planned per-card shares helper (for the pattern checks). */
function pairs(p: Pool, planned: number[]) {
  return p.values.map((v, i) => ({
    value: v,
    live: (p.livePcts[i] ?? 0) / 100,
    planned: planned[i] ?? 0,
  }));
}

// ════════════════════════════════════════════════════════════════════════
// PATTERN 1 — single-carrier loss-ladder collapse + healthy-card crush
// ════════════════════════════════════════════════════════════════════════
// CHECK crush-guard: for every card with live ≥ 5%, planned must NOT be ≤ 0.005%.
// CHECK carrier-guard: max over loss cards of (planned − live) ≤ 25pp.
// These describe a HEALTHY plan. At the ±10% default budget a degenerate plan
// is DEMOTED (leads with a pool edit), but the guard's DETECTION must fire on
// the owner's flagged pools — the shape guard classifies them DEGENERATE.
function crushGuardViolations(p: Pool, planned: number[]): number {
  let n = 0;
  for (const c of pairs(p, planned)) {
    if (c.live >= 0.05 && c.planned > 0 && c.planned <= 0.00005) n += 1;
  }
  return n;
}
function carrierExcessPp(p: Pool, planned: number[], price: number): number {
  let max = 0;
  for (const c of pairs(p, planned)) {
    if (c.value > 0 && c.value < price) {
      const excess = (c.planned - c.live) * 100;
      if (excess > max) max = excess;
    }
  }
  return max;
}

check("P1 detection: the owner's crush pools (Captive, Tails?) read DEGENERATE in the RAW layout", () => {
  // The shape guard's teeth are on the RAW fixed-pool layout (disperse=false):
  // both the owner's flagged pools classify DEGENERATE before the dispersion
  // pass. Captive stays degenerate even after dispersion (EV-forced — pool-edit
  // path); Tails? is a layout crush that dispersion FIXES (pinned separately).
  for (const p of [CAPTIVE, TAILS]) {
    const out = solve(p, RETUNE_PRICE_BUDGET_DEFAULT_PCT, false);
    assert(out.price !== null && out.planned !== null, `${p.name} must be feasible in-band`);
    const s = ladderShape(p.values, toShares(p.livePcts), out.planned!, out.price!);
    assert(s.degenerate, `${p.name}: the shape guard must flag the raw collapse (score ${s.score.toFixed(3)})`);
  }
});

check("P1 detection: the RAW crush layout trips crush-guard OR carrier-guard (the flag has teeth)", () => {
  for (const p of [CAPTIVE, TAILS]) {
    const out = solve(p, RETUNE_PRICE_BUDGET_DEFAULT_PCT, false);
    assert(out.planned !== null && out.price !== null, `${p.name} feasible`);
    const crushed = crushGuardViolations(p, out.planned!);
    const carrier = carrierExcessPp(p, out.planned!, out.price!);
    assert(
      crushed > 0 || carrier > 25,
      `${p.name}: raw crush layout must violate crush (${crushed}) or carrier (+${carrier.toFixed(1)}pp) guard`,
    );
  }
});

check("P1 fix: dispersion + LAW M resolve BOTH crushes — Tails? (layout) and Captive (was called EV-forced)", () => {
  // Tails? — a layout crush → dispersion spreads the loss mass and it reads
  // HEALTHY. Captive — pre-V3 the solve dumped the loss mass on the single
  // $80.28 carrier and the story was "EV-forced, pool-edit owns it". Under
  // LAW M the gate re-lays that zigzag into a lawful ladder that spreads the
  // loss mass down the chain (≈15.8/20.5/20.5/29?) — HEALTHY at the same
  // landed edge. The crush was solver-forced, not physics-forced.
  const tailsFixed = solve(TAILS, RETUNE_PRICE_BUDGET_DEFAULT_PCT, true);
  assert(tailsFixed.planned !== null && tailsFixed.price !== null, "Tails? feasible");
  const sTails = ladderShape(TAILS.values, toShares(TAILS.livePcts), tailsFixed.planned!, tailsFixed.price!);
  assert(!sTails.degenerate, `dispersion resolves Tails? (score ${sTails.score.toFixed(3)})`);
  const captiveFixed = solve(CAPTIVE, RETUNE_PRICE_BUDGET_DEFAULT_PCT, true);
  assert(captiveFixed.planned !== null && captiveFixed.price !== null, "Captive feasible");
  const sCap = ladderShape(CAPTIVE.values, toShares(CAPTIVE.livePcts), captiveFixed.planned!, captiveFixed.price!);
  assert(
    !sCap.degenerate && sCap.crushedCount === 0,
    `LAW M resolves Captive too (score ${sCap.score.toFixed(3)}, crush ${sCap.crushedCount})`,
  );
  assert(
    findMonotoneViolations({ values: CAPTIVE.values, shares: captiveFixed.planned! }).length === 0,
    "Captive's plan is LAW-M-clean end to end",
  );
});

check("P1 pool-edits-first: a degenerate plan yields a non-null poolEditPlan (the escape)", () => {
  const out = solve(CAPTIVE, RETUNE_PRICE_BUDGET_DEFAULT_PCT);
  assert(out.planned !== null && out.price !== null, "Captive feasible");
  const g = computeUntaggedGuidance({
    cards: CAPTIVE.values.map((v) => ({ value: v })),
    currentWeights: toWeights(CAPTIVE.livePcts),
    cardIds: CAPTIVE.values.map((_, i) => `c${i}`),
    livePrice: CAPTIVE.price,
    price: out.price!,
    targetEdge: out.targets.targetEdge,
    targetWinRate: out.targets.targetWinRate,
    nearMissMin: out.targets.nearMissMin,
    maxWinCap: out.targets.maxWinCap,
    plannedShares: out.planned!,
    relaxations: [],
    shapeDegenerate: true,
  });
  assert(g !== null, "Captive degenerate → guidance non-null");
  const pe = derivePoolEditPlan(g, "degenerate-shape", CAPTIVE.price, RETUNE_PRICE_BUDGET_DEFAULT_PCT);
  assert(pe !== null, "a degenerate plan must carry a pool-edit escape");
});

// ════════════════════════════════════════════════════════════════════════
// PATTERN 1 (fix) — LOSS-MASS DISPERSION (owner-lens item 10)
// ════════════════════════════════════════════════════════════════════════
// The dispersion pass turns a crush ladder HEALTHY where the crush is a layout
// artifact (the loss average leaves room to spread), and is a NO-OP where the
// crush is EV-forced (the pool-edit path owns those). It holds the band mass +
// EV, so edge / win-rate / tag are preserved.
check("disperseLossBand: min-L2 spread holds mass + EV exactly and lowers the max share", () => {
  // A concentrated 3-card loss band with the mean in range → the affine spread
  // moves mass off the carrier, keeping mass + EV to floating point. Every card
  // keeps a REAL (non-floor) share on both sides — the never-newly-crush guard
  // (attempt #2, item B) is a no-op here since the affine fit stays fully
  // non-negative for all three cards.
  const values = [10, 20, 30];
  const w = [0.2, 0.6, 0.05];
  const mass = w.reduce((a, b) => a + b, 0);
  const ev0 = w.reduce((a, x, i) => a + x * values[i]!, 0);
  const out = disperseLossBand(values, w, mass);
  const outMass = out.reduce((a, b) => a + b, 0);
  const outEv = out.reduce((a, x, i) => a + x * values[i]!, 0);
  assert(Math.abs(outMass - mass) < 1e-9, `mass held (${outMass} vs ${mass})`);
  assert(Math.abs(outEv - ev0) < 1e-9, `EV held (${outEv} vs ${ev0})`);
  assert(Math.max(...out) < Math.max(...w) - 1e-9, "the carrier's share is lowered (dispersed)");
  assert(out.every((x) => x > 0.0001), "no card is crushed by the spread");
});

check("disperseLossBand: NEVER-NEWLY-CRUSH guard — rejects a spread that would floor-pin a real-mass card (attempt #2, item B)", () => {
  // The near-miss floor-pin bug this guard fixes: a card with REAL input mass
  // (well above quantization noise) sits at the EXPENSIVE end of the loss band;
  // the unconstrained affine fit needs NEGATIVE weight there (the required mean
  // is dragged low by a cheap concentration), so the OLD active-set solve
  // dropped it to 0 — silently turning a healthy card into a brand-new
  // 0%/floor-pinned one. The guard now REJECTS that spread and returns the
  // input UNCHANGED instead (byte-identical — no dispersion — rather than a
  // worse ladder than what existed before the pass ran).
  const values = [20.53, 18.16, 12.41, 7.3, 3.62, 1.21];
  const w = [0.019216, 0.02967, 0.114251, 0.001406, 0.016859, 0.818598];
  const mass = w.reduce((a, b) => a + b, 0);
  const out = disperseLossBand(values, w, mass);
  assert(
    out.every((x, i) => Math.abs(x - w[i]!) < 1e-9),
    "a spread that would crush a real-mass card is rejected — input returned unchanged",
  );
});

check("disperseLossBand: DOES disperse when the affine fit keeps every real-mass card positive (no false refusal)", () => {
  // The guard must not become a blanket "never disperse a wide-value band" —
  // when the min-L2 fit keeps every card ≥ the floor, the spread still applies.
  const values = [50, 30, 10];
  const w = [0.05, 0.1, 0.2];
  const mass = w.reduce((a, b) => a + b, 0);
  const out = disperseLossBand(values, w, mass);
  assert(out.some((x, i) => Math.abs(x - w[i]!) > 1e-9), "the spread is applied (not rejected)");
  assert(out.every((x) => x > 0.0001), "no card crushed");
});

check("disperseLossBand: EV-forced band (avg near the max) is a no-op; single value is a no-op", () => {
  // Captive's loss side: avg ≈ $61 across $80/$34/$18 → only $80 can carry it →
  // the affine solution clamps to the same one-carrier shape (no dispersion).
  const evForced = disperseLossBand([18.23, 33.95, 80.28], [0.0001, 0.0001, 0.76], 0.7602);
  assert(evForced[2]! >= 0.76 - 1e-3, "the EV-forced carrier keeps (nearly) all its mass");
  // A single-value band can't be dispersed — returned unchanged.
  const single = disperseLossBand([10], [0.5], 0.5);
  assert(single.length === 1 && Math.abs(single[0]! - 0.5) < 1e-12, "single card → unchanged");
});

check("dispersion: crush ladders become HEALTHY (9-5, Best Friends, High Tides) with edge/wr held", () => {
  // Each of these crushes a live-≥5% loss card to the quantization floor in the
  // fixed-pool default; the dispersion pass re-spreads the loss band and the
  // shape guard reads HEALTHY (< 0.25) — without dropping edge below live.
  for (const p of [NINE_FIVE, BEST_FRIENDS, HIGH_TIDES]) {
    const off = solve(p, RETUNE_PRICE_BUDGET_DEFAULT_PCT, false);
    const on = solve(p, RETUNE_PRICE_BUDGET_DEFAULT_PCT, true);
    assert(off.price !== null && off.planned !== null, `${p.name} feasible (no disperse)`);
    assert(on.price !== null && on.planned !== null, `${p.name} feasible (disperse)`);
    const sOff = ladderShape(p.values, toShares(p.livePcts), off.planned!, off.price!);
    const sOn = ladderShape(p.values, toShares(p.livePcts), on.planned!, on.price!);
    assert(sOff.degenerate, `${p.name}: the fixed-pool default is a crush ladder (shape ${sOff.score.toFixed(2)})`);
    assert(
      !sOn.degenerate && sOn.score < 0.25,
      `${p.name}: dispersion makes the ladder HEALTHY (shape ${sOff.score.toFixed(2)} → ${sOn.score.toFixed(2)})`,
    );
    // Edge held ≥ live (never refunded) and win-rate unchanged within tolerance.
    assert(
      on.after!.edge >= off.before.edge - 0.0006 - 1e-9,
      `${p.name}: dispersion never drops edge below live (${(on.after!.edge * 100).toFixed(3)}% vs live ${(off.before.edge * 100).toFixed(3)}%)`,
    );
  }
});

check("dispersion + LAW M: Captive's crush is a RETUNE-PATH artifact — raw layout degenerate, lawful re-lay healthy", () => {
  // Pre-V3 this check pinned Captive as "EV-forced, dispersion is a no-op,
  // pool-edit owns it". The LAW M gate disproved the premise: the retune path
  // (disperse on) re-lays the $80.28 carrier crush into a healthy lawful
  // ladder at the SAME landed edge. The RAW path (disperse off — the legacy
  // direct callers, no gate) still shows the crush: the contrast proves the
  // fix lives in the retune path, not in the fixture.
  const off = solve(CAPTIVE, RETUNE_PRICE_BUDGET_DEFAULT_PCT, false);
  const on = solve(CAPTIVE, RETUNE_PRICE_BUDGET_DEFAULT_PCT, true);
  assert(off.planned !== null && on.planned !== null, "Captive feasible both ways");
  const sOff = ladderShape(CAPTIVE.values, toShares(CAPTIVE.livePcts), off.planned!, off.price!);
  assert(sOff.degenerate, `the RAW (no-disperse) layout still crushes (shape ${sOff.score.toFixed(2)})`);
  const sOn = ladderShape(CAPTIVE.values, toShares(CAPTIVE.livePcts), on.planned!, on.price!);
  assert(
    !sOn.degenerate && sOn.crushedCount === 0,
    `the retune path lands lawful + healthy (shape ${sOn.score.toFixed(2)})`,
  );
});

// ════════════════════════════════════════════════════════════════════════
// PATTERN 2 — runaway benefit-free price moves
// ════════════════════════════════════════════════════════════════════════
// CHECK price-budget: |priceAfter − live|/live ≤ 0.10 for every DEFAULT plan.
check("P2 price-budget: every default (±10%) plan stays within 10% of live price", () => {
  for (const p of [CHAOS, TAILS, CAPTIVE, BIDOOF]) {
    const out = solve(p, RETUNE_PRICE_BUDGET_DEFAULT_PCT);
    if (out.price === null) continue; // infeasible in-band is honest, no price move
    const moved = Math.abs(out.price - p.price) / p.price;
    assert(
      moved <= 0.1 + 1e-9,
      `${p.name}: default plan moved ${(moved * 100).toFixed(1)}% (budget 10%)`,
    );
  }
});

check("P2 the ±60% band still cuts hard — the budget is what tames it (Chaos)", () => {
  const wide = solve(CHAOS, RETUNE_MAX_PRICE_CHANGE_PCT);
  const def = solve(CHAOS, RETUNE_PRICE_BUDGET_DEFAULT_PCT);
  assert(wide.price !== null && def.price !== null, "Chaos feasible at both bands");
  assert(wide.price! < 2.0, `±60% cuts Chaos hard (got $${wide.price})`);
  assert(
    Math.abs(def.price! - CHAOS.price) / CHAOS.price <= 0.1 + 1e-9,
    `±10% holds Chaos near live (got $${def.price})`,
  );
});

// ════════════════════════════════════════════════════════════════════════
// PATTERN 3 — untagged win-rate float: live-anchored targets
// ════════════════════════════════════════════════════════════════════════
// CHECK winrate-drift: |after.winRate − live.winRate| ≤ 5pp for untagged.
// (Live-anchored targets, Wave 1 — the 20% recipe no longer rewrites the design.)
check("P3 winrate-drift: an untagged plan holds within 5pp of the live win-rate (Tails?)", () => {
  const out = solve(TAILS, RETUNE_PRICE_BUDGET_DEFAULT_PCT);
  assert(out.after !== null, "Tails? feasible");
  const drift = Math.abs(out.after!.winRate - out.before.winRate);
  assert(
    drift <= 0.05 + 1e-6,
    `Tails? untagged win-rate drift ${(drift * 100).toFixed(1)}pp (≤ 5pp)`,
  );
});

check("P3 target: an untagged pack targets its OWN live win-rate, not the flat 20% recipe", () => {
  // Captive lives at ~40% winners... its untagged target must anchor to live,
  // never snap to the 0.20 default.
  const before = computePackRisk({
    cards: CAPTIVE.values.map((v, i) => ({ value: v, weight: toWeights(CAPTIVE.livePcts)[i]! })),
    price: CAPTIVE.price,
  });
  const t = autoRetuneTargets(CAPTIVE.price, CFG, undefined, Math.max(...CAPTIVE.values), {
    winRate: before.winRate,
    nearMiss: before.nearMiss,
    edge: before.edge,
    topValue: Math.max(...CAPTIVE.values),
  });
  assert(
    Math.abs(t.targetWinRate - DEFAULT_TARGET_WIN_RATE) > 1e-6,
    `an untagged pack with a live pool must not target the flat ${DEFAULT_TARGET_WIN_RATE} (got ${t.targetWinRate})`,
  );
  assert(
    Math.abs(t.targetWinRate - before.winRate) <= 1e-6,
    `untagged target must equal the (in-band) live win-rate (got ${t.targetWinRate} vs live ${before.winRate})`,
  );
});

// ════════════════════════════════════════════════════════════════════════
// PATTERN 4 — the "50/50" DB tag is invisible to the tag system
// ════════════════════════════════════════════════════════════════════════
// CHECK tag-5050: resolveIntendedHitRate(name, ["50/50"]) === 0.5.
// CHECK tag-5050-plan: a 50/50-tagged pack plans with intendedHitRate 0.5.
// CHECK no-tag-copy: no "has no tag" copy for a pack that resolves a tag.
const GREEN_OR_BUST: Pool = {
  // A coin-flip pack (values chosen so a 50% win rate is reachable): one winner
  // above price, one dust card below, plus filler — the tag is the DB "50/50".
  name: "Green Or Bust",
  price: 10,
  values: [22, 12, 0.6],
  livePcts: [30, 20, 50],
  tag: null,
  tags: ["50/50"],
};

check("P4 tag-5050: resolveIntendedHitRate resolves the literal DB '50/50' tag to 0.5", () => {
  assert(
    resolveIntendedHitRate("Green Or Bust", ["50/50"]) === 0.5,
    "the 50/50 product tier must resolve to a 0.5 hit-rate",
  );
  assert(
    resolveIntendedHitRate("The Four Horseman", ["50/50"]) === 0.5,
    "50/50 resolves regardless of pack name",
  );
  // A ratio above 50% winners is not a lottery product — rejected (untagged).
  assert(resolveIntendedHitRate("x", ["90/10"]) === null, "90/10 is not a lottery tag");
});

check("P4 tag-5050-plan: a 50/50-tagged pack plans as a TAGGED 0.5 pack (not untagged 20%)", () => {
  const out = solve(GREEN_OR_BUST, RETUNE_PRICE_BUDGET_DEFAULT_PCT);
  assert(out.targets.intendedHitRate === 0.5, `intendedHitRate must be 0.5 (got ${out.targets.intendedHitRate})`);
  assert(
    Math.abs(out.targets.targetWinRate - 0.5) < 1e-9,
    `target win-rate must be the 50% tag, not 20% (got ${out.targets.targetWinRate})`,
  );
});

check("P4 no-tag-copy: relaxationLine never says 'has no tag' for a pack that resolves a tag", () => {
  const tags = [0.5, 0.1, 0.05, 0.01];
  const grid = [
    { requested: 0.5, applied: 0.5 }, // note (no float)
    { requested: 0.5, applied: 0.52 }, // float up
    { requested: 0.5, applied: 0.48 }, // ease down
  ];
  for (const tag of tags) {
    for (const g of grid) {
      const line = relaxationLine(
        { lever: "winRate", requested: g.requested, applied: g.applied, reason: "engine note." },
        { tag },
      );
      assert(
        !line.includes("has no tag"),
        `tag=${tag} req=${g.requested} app=${g.applied}: must not claim "has no tag"`,
      );
    }
  }
  // The untagged case DOES keep the "has no tag" copy (unchanged).
  const untagged = relaxationLine(
    { lever: "winRate", requested: 0.2, applied: 0.28, reason: "x" },
    { tag: null },
  );
  assert(untagged.includes("has no tag"), "untagged float still says 'has no tag'");
});

// ════════════════════════════════════════════════════════════════════════
// PATTERN 5 — silent jackpot deletion by the untagged cap (grandfathering)
// ════════════════════════════════════════════════════════════════════════
// CHECK cap-grandfather: a pack whose live top value exceeds the auto cap keeps
// it — the resolved maxWinCap ≥ live top (the owner already runs it).
check("P5 cap-grandfather: a live over-cap top card is grandfathered into the retune cap", () => {
  // A $0.15 micro pack with a $306 top (2040x) — the plain untagged cap
  // (price·100) is $15, which would delete the jackpot. Grandfathering keeps it.
  const price = 0.15;
  const liveTop = 306;
  const t = autoRetuneTargets(price, CFG, undefined, liveTop, {
    winRate: 0.2,
    nearMiss: 0,
    edge: 0.11,
    topValue: liveTop,
  });
  assert(
    t.maxWinCap >= liveTop - 1e-9,
    `the resolved cap must grandfather the live $${liveTop} top (got cap $${t.maxWinCap})`,
  );
});

check("P5 cap does NOT escalate: a live top BELOW the auto cap leaves the cap unchanged", () => {
  const price = 100;
  const tWithLow = autoRetuneTargets(price, CFG, undefined, 500, {
    winRate: 0.2,
    nearMiss: 0,
    edge: 0.11,
    topValue: 500,
  });
  const tNoLive = autoRetuneTargets(price, CFG, undefined, 500, null);
  assert(
    Math.abs(tWithLow.maxWinCap - tNoLive.maxWinCap) < 1e-9,
    "a below-cap live top must not change the cap (grandfather only loosens)",
  );
});

// ════════════════════════════════════════════════════════════════════════
// PATTERN 6 — risk-tier / CV drift: the risk book must not silently flatten
// ════════════════════════════════════════════════════════════════════════
// CHECK tier-hold: a widened band holds the pack's live CV (no forced flip).
check("P6 band widens to the live CV — the owner's hot-runner keeps its leverage (Chaos)", () => {
  const before = computePackRisk({
    cards: CHAOS.values.map((v, i) => ({ value: v, weight: toWeights(CHAOS.livePcts)[i]! })),
    price: CHAOS.price,
  });
  const band = packRiskBand({ tag: 0.1, price: CHAOS.price, liveCv: before.cv });
  assert(band.widenedToLive, "Chaos' deliberate high CV must widen the tag-law band");
  assert(
    !isRiskBandExit(before.cv, band),
    `the live CV must sit INSIDE its own widened band (cv ${before.cv.toFixed(2)}, band ${band.lo.toFixed(2)}–${band.hi.toFixed(2)})`,
  );
});

check("P6 cv-band: a non-degenerate default plan holds 0.5x–2x its live CV (Bidoof)", () => {
  const out = solve(BIDOOF, RETUNE_PRICE_BUDGET_DEFAULT_PCT);
  assert(out.after !== null, "Bidoof feasible");
  const ratio = out.after!.cv / out.before.cv;
  assert(
    ratio >= 0.5 - 1e-9 && ratio <= 2.0 + 1e-9,
    `Bidoof CV ratio ${ratio.toFixed(2)} must stay in [0.5, 2.0]`,
  );
});

check("P6 a synthetic band exit + tier flip is detected (the demotion trigger has teeth)", () => {
  const band = packRiskBand({ tag: null, price: 10, liveCv: 2.0 });
  assert(isRiskBandExit(band.hi + 1, band), "a CV above the band's hi must read as an exit");
  assert(!isRiskBandExit((band.lo + band.hi) / 2, band), "a mid-band CV must NOT read as an exit");
});

// ════════════════════════════════════════════════════════════════════════
// PATTERN 7 — edge give-back on above-target packs
// ════════════════════════════════════════════════════════════════════════
// CHECK no-edge-giveback: if live edge ≥ target, plan.after.edge ≥ live.edge − 0.1pp.
check("P7 no-edge-giveback: an above-target live edge is held (never refunded), bounded by ceiling", () => {
  // A modest above-target live edge (curve target ≈ 11%) — the resolved target
  // must HOLD it (never plan below live − 0.1pp), bounded only by the edge
  // ceiling. A pathological live edge above the ceiling is capped AT the ceiling
  // (players are protected) — that is correct, not a give-back.
  const price = 20;
  const top = 500;
  const liveEdge = 0.113; // ~0.3pp above the curve target
  const t = autoRetuneTargets(price, CFG, undefined, top, {
    winRate: 0.2,
    nearMiss: 0,
    edge: liveEdge,
    topValue: top,
  });
  // Below the ceiling → the target holds the live edge (never refunds it).
  assert(
    t.targetEdge >= liveEdge - 0.001 - 1e-9,
    `above-target: target ${(t.targetEdge * 100).toFixed(3)}% must not undercut live ${(liveEdge * 100).toFixed(3)}%`,
  );
});

check("P7 below-target packs still lift to the curve target (never-below-live is one-sided)", () => {
  // A live edge BELOW the curve target lifts UP to the curve — the guard never
  // pulls a healthy retune DOWN.
  const price = 20;
  const top = 500;
  const lowLiveEdge = 0.08;
  const t = autoRetuneTargets(price, CFG, undefined, top, {
    winRate: 0.2,
    nearMiss: 0,
    edge: lowLiveEdge,
    topValue: top,
  });
  assert(
    t.targetEdge > lowLiveEdge + 1e-9,
    `a below-target pack must lift to the curve target (target ${(t.targetEdge * 100).toFixed(3)}% vs live ${(lowLiveEdge * 100).toFixed(3)}%)`,
  );
});

// ════════════════════════════════════════════════════════════════════════
// PATTERN 8 — near-live micro-fix ignored by the plan (budget forces near-live)
// ════════════════════════════════════════════════════════════════════════
// CHECK guidance-consistency (proxy): the ±10% budget keeps the default plan
// near live — a big benefit-free cut can no longer be the default.
check("P8 the budget keeps Bidoof near live (no −41% cut when a near-live plan exists)", () => {
  const out = solve(BIDOOF, RETUNE_PRICE_BUDGET_DEFAULT_PCT);
  assert(out.price !== null, "Bidoof feasible in-band");
  const moved = Math.abs(out.price! - BIDOOF.price) / BIDOOF.price;
  assert(moved <= 0.1 + 1e-9, `Bidoof default plan stays near live (moved ${(moved * 100).toFixed(1)}%)`);
});

// ════════════════════════════════════════════════════════════════════════
// PATTERN 9 — copy & guidance contradiction cluster
// ════════════════════════════════════════════════════════════════════════
// CHECK copy-direction: no relaxation string says "relaxed"/"floated up" on a
//   downward move.
check("P9a copy-direction: a downward win-rate move is never 'floated up' / 'relaxed'", () => {
  const down = relaxationLine(
    { lever: "winRate", requested: 0.3, applied: 0.24, reason: "x" },
    { tag: null },
  );
  assert(!/relaxed|floated up/i.test(down), `a downward move must not read as raised: "${down}"`);
  assert(/eased down/i.test(down), `a downward move should read 'eased down': "${down}"`);
  const up = relaxationLine(
    { lever: "winRate", requested: 0.2, applied: 0.28, reason: "x" },
    { tag: null },
  );
  assert(/floated up/i.test(up), `an upward move should read 'floated up': "${up}"`);
});

// CHECK copy-degenerate: a degenerate ladder's guidance carries no "Fine to push as-is".
check("P9c copy-degenerate: a DEGENERATE plan's accept-as-is drops the 'Fine to push as-is' blessing", () => {
  const out = solve(CAPTIVE, RETUNE_PRICE_BUDGET_DEFAULT_PCT);
  assert(out.planned !== null && out.price !== null, "Captive feasible");
  const g = computeUntaggedGuidance({
    cards: CAPTIVE.values.map((v) => ({ value: v })),
    currentWeights: toWeights(CAPTIVE.livePcts),
    cardIds: CAPTIVE.values.map((_, i) => `c${i}`),
    livePrice: CAPTIVE.price,
    price: out.price!,
    targetEdge: out.targets.targetEdge,
    targetWinRate: out.targets.targetWinRate,
    nearMissMin: out.targets.nearMissMin,
    maxWinCap: out.targets.maxWinCap,
    plannedShares: out.planned!,
    relaxations: [],
    shapeDegenerate: true,
  });
  assert(g !== null, "Captive degenerate guidance non-null");
  for (const s of g!.suggestions) {
    assert(
      !s.humanCopy.includes("Fine to push as-is"),
      `no suggestion may bless a degenerate ladder with 'Fine to push as-is' (${s.kind})`,
    );
  }
});

// CHECK copy-noop: pruneNoOpSuggestions drops a price suggestion equal to priceAfter.
check("P9h copy-noop: a price suggestion equal to the plan's own price is pruned", () => {
  const g: TagGuidance = {
    feasibility: {
      evTarget: 0,
      evMin: 0,
      evMax: 0,
      feasible: true,
      saturated: false,
      direction: "ok",
      components: { winEvMin: 0, winEvMax: 0, nmMass: 0, dustMass: 0, capSum: 0 },
    },
    suggestions: [
      { kind: "price-move", params: { price: 4.38 }, humanCopy: "no-op", proof: { evMinAfter: 0, evMaxAfter: 0, feasibleAfter: true } },
      { kind: "add-card", params: { valueMin: 1, valueMax: 2, suggestedValue: 1.5, expectedShare: 0.1 }, humanCopy: "real", proof: { evMinAfter: 0, evMaxAfter: 0, feasibleAfter: true } },
    ],
  };
  const pruned = pruneNoOpSuggestions(g, 4.38);
  assert(pruned !== null, "prune returns guidance");
  assert(
    !pruned!.suggestions.some((s) => s.kind === "price-move"),
    "the no-op price-move (= the plan's own price) must be pruned",
  );
  assert(
    pruned!.suggestions.some((s) => s.kind === "add-card"),
    "the real fix survives the prune",
  );
  // A genuinely different price is kept.
  const kept = pruneNoOpSuggestions(g, 3.96);
  assert(
    kept!.suggestions.some((s) => s.kind === "price-move"),
    "a price suggestion that differs from the plan price is kept",
  );
});

// CHECK copy-numbers (structural): the status badge for a degenerate plan exists.
check("P9d/9-status: the degenerate-ladder status badge exists (the plan is honestly labeled)", () => {
  assert(
    typeof STATUS_BADGE.plannedDegenerate === "string" &&
      STATUS_BADGE.plannedDegenerate.length > 0,
    "STATUS_BADGE.plannedDegenerate must exist",
  );
});

// CHECK poolEditSummary renders honest, complete copy (no absurd share, budget flag).
check("P9 poolEditSummary renders the add-card band, removals, price + budget flag", () => {
  const copy = poolEditSummary({
    addCard: { valueMin: 281.79, valueMax: 327.39, suggestedValue: 310.16, expectedShare: 0.1 },
    removeCount: 2,
    price: 344.62,
    beyondBudget: true,
  });
  assert(copy.includes("281.79") && copy.includes("327.39"), "add-card band shown");
  assert(copy.includes("310.16"), "suggested value shown");
  assert(copy.includes("remove 2 dead cards"), "removals shown");
  assert(copy.includes("outside the ±10% budget"), "beyond-budget flagged");
  assert(copy.includes("Solver-verified"), "solver-verified claim present");
});

// ════════════════════════════════════════════════════════════════════════
// PATTERN 10 — dirty-odds dead-end: pool-edit-first, never "nudge the price"
// ════════════════════════════════════════════════════════════════════════
check("P10 deadend copy: a dead-end dirty banner points at the pool edit, never 'nudge the price'", () => {
  const dead = dirtyOddsBanner(3, 12, true);
  assert(!/nudge the price/i.test(dead), `dead-end banner must not say 'nudge the price': "${dead}"`);
  assert(/edit the pool/i.test(dead), `dead-end banner leads with the pool edit: "${dead}"`);
  // A non-dead-end dirty plan keeps the price/swap hint (unchanged).
  const normal = dirtyOddsBanner(3, 12, false);
  assert(/nudge the price/i.test(normal), "a non-dead-end dirty banner keeps the price hint");
});

check("P10 escape: a degenerate/infeasible guidance derives a poolEditPlan (the path exists)", () => {
  // Tails? (complaint B) — the pool-edit escape must exist after the §2.3 fix.
  const out = solve(TAILS, RETUNE_PRICE_BUDGET_DEFAULT_PCT);
  assert(out.planned !== null && out.price !== null, "Tails? feasible");
  const g = computeUntaggedGuidance({
    cards: TAILS.values.map((v) => ({ value: v })),
    currentWeights: toWeights(TAILS.livePcts),
    cardIds: TAILS.values.map((_, i) => `c${i}`),
    livePrice: TAILS.price,
    price: out.price!,
    targetEdge: out.targets.targetEdge,
    targetWinRate: out.targets.targetWinRate,
    nearMissMin: out.targets.nearMissMin,
    maxWinCap: out.targets.maxWinCap,
    plannedShares: out.planned!,
    relaxations: [],
    shapeDegenerate: true,
  });
  assert(g !== null, "Tails? shape-degenerate guidance must be non-null (the §2.3 fix)");
});

// ════════════════════════════════════════════════════════════════════════
// PATTERN 11 — equal-value dust churn: deterministic tie-breaking
// ════════════════════════════════════════════════════════════════════════
// CHECK dust-stability: among equal-value cards, the buffer tie-break resolves
//   toward the higher LIVE weight (the modal live card stays modal), so no pair
//   of equal-value cards has one losing >10pp while the other gains >10pp for a
//   reason that's just array index.
check("P11 dust-stability: the buffer (residual absorber) FOLLOWS the modal live card", () => {
  // Two equal-value dust cards the water-fill split evenly (equal planned
  // weights). The buffer — the residual-absorbing modal card — must be the one
  // that was MODAL in the live pool, not the array-index default. Default
  // first-max-wins picks the EARLIER index; the tie-break must flip the buffer
  // to the later index when THAT card was the live-modal one.
  const weights = [1, 4000, 4000]; // [winner, dustA, dustB] equal dust weights
  // Case A: dustA (index 1) is live-modal → buffer must be index 1.
  const bufA = bufferIndex(snapWeightsToCleanLadder({ weights, price: 10, tieBreakWeights: [100, 790000, 10] }));
  assert(bufA === 1, `dustA live-modal → buffer must be index 1 (got ${bufA})`);
  // Case B: dustB (index 2) is live-modal → the tie-break must FLIP the buffer
  // to index 2 (the default first-max-wins would keep index 1).
  const bufB = bufferIndex(snapWeightsToCleanLadder({ weights, price: 10, tieBreakWeights: [100, 10, 790000] }));
  assert(bufB === 2, `dustB live-modal → tie-break must flip the buffer to index 2 (got ${bufB})`);
  // Without a tie-break the default keeps the earlier index (deterministic).
  const bufDefault = bufferIndex(snapWeightsToCleanLadder({ weights, price: 10 }));
  assert(bufDefault === 1, `no tie-break → default first-index buffer (got ${bufDefault})`);
});

check("P11 tie-break is a NO-OP on the group total (EV / cleanness preserved)", () => {
  const weights = [1, 4000, 4000];
  const liveA = [100, 790000, 10];
  const liveB = [100, 10, 790000];
  const snapA = snapWeightsToCleanLadder({ weights, price: 10, tieBreakWeights: liveA });
  const snapB = snapWeightsToCleanLadder({ weights, price: 10, tieBreakWeights: liveB });
  const totA = snapA.weights.reduce((a, b) => a + b, 0);
  const totB = snapB.weights.reduce((a, b) => a + b, 0);
  // Same group total either way — the tie-break only swaps WHICH equal card is
  // the buffer, so the two equal cards' COMBINED share is identical.
  const combinedA = (snapA.weights[1]! + snapA.weights[2]!) / totA;
  const combinedB = (snapB.weights[1]! + snapB.weights[2]!) / totB;
  assert(
    Math.abs(combinedA - combinedB) < 1e-9,
    `the equal-value group's combined share must be tie-break-invariant (${combinedA} vs ${combinedB})`,
  );
});

check("P11 tie-break is deterministic (byte-identical on a re-run)", () => {
  const weights = [1, 4000, 4000];
  const live = [100, 790000, 10];
  const a = snapWeightsToCleanLadder({ weights: weights.slice(), price: 10, tieBreakWeights: live });
  const b = snapWeightsToCleanLadder({ weights: weights.slice(), price: 10, tieBreakWeights: live });
  assert(
    a.weights.every((w, i) => w === b.weights[i]),
    "the snap tie-break must be deterministic",
  );
});

// ════════════════════════════════════════════════════════════════════════
// PATTERN 12 — LOSS/SUB-PRICE MONOTONICITY INVARIANT (owner rule, universal)
// ════════════════════════════════════════════════════════════════════════
// THE invariant (owner, 2026-07-03): among the FREE (non-pinned) cards priced
// BELOW the pack price — the NEARMISS + DUST loss bands — probability must be
// MONOTONICALLY NON-INCREASING in card value: the CHEAPEST card always carries
// the HIGHEST odds, no inversions. Pinned cards are fixed exceptions (excluded
// from the chain). The single residual-BUFFER card (argmax loss weight) is
// exempt — the same exemption `repairSnapMonotonicity` uses and the whole fleet
// already respects (survey: 0 buffer-exempt violations). The WIN band (value ≥
// price) is DELIBERATELY non-monotone and is NOT asserted here.
//
// This encodes the "10% Divine Order" defect: the owner staged 3 added sub-price
// cards + 3 pins and the plan scrambled the loss band ascending in value
// (562.22→20%, 299.99→30%, 111.02→0.001% — a rich loss card likelier than a
// cheap one). The engine now REPAIRS a fixable inversion (mass held) and REFUSES
// (`loss-nonmonotone`) when no monotone layout exists at the required loss mean —
// never ships the garbage ordering.

/**
 * Count buffer-exempt monotone violations in a planned vector: among free
 * (non-pinned) below-price loss cards, EXCLUDING the single argmax buffer, the
 * number of adjacent (cheap→rich) pairs where the pricier card is MORE likely.
 * This is EXACTLY the invariant the gate asserts (== 0) and the engine enforces.
 */
function lossMonotoneViolations(
  values: number[],
  weights: number[],
  price: number,
  pinnedIdx: ReadonlySet<number> = new Set(),
): number {
  const total = weights.reduce((a, b) => a + (b > 0 ? b : 0), 0);
  if (!(total > 0)) return 0;
  const loss = values
    .map((v, i) => ({ i, v, w: weights[i]! }))
    .filter((x) => !pinnedIdx.has(x.i) && x.v > 0 && x.v < price && x.w > 0);
  if (loss.length < 2) return 0;
  // buffer = argmax weight (ties → cheapest), the residual absorber.
  let buf = 0;
  for (let k = 1; k < loss.length; k++) {
    if (loss[k]!.w > loss[buf]!.w || (loss[k]!.w === loss[buf]!.w && loss[k]!.v < loss[buf]!.v)) buf = k;
  }
  const chain = loss.filter((_, k) => k !== buf).sort((a, b) => a.v - b.v);
  let viol = 0;
  for (let k = 0; k + 1 < chain.length; k++) {
    if (chain[k]!.w < chain[k + 1]!.w - 1e-9) viol += 1;
  }
  return viol;
}

// The full fleet used elsewhere in this suite + the planner-discipline suite.
const P12_FLEET: Pool[] = [
  CHAOS, TAILS, CAPTIVE, BIDOOF, NINE_FIVE, BEST_FRIENDS, HIGH_TIDES,
];

check("P12 invariant: EVERY feasible fleet plan obeys the loss-monotone rule (0 violations)", () => {
  let violatingPlans = 0;
  const detail: string[] = [];
  for (const p of P12_FLEET) {
    for (const band of [RETUNE_PRICE_BUDGET_DEFAULT_PCT, RETUNE_MAX_PRICE_CHANGE_PCT]) {
      const out = solve(p, band);
      if (out.weights === null || out.price === null) continue; // infeasible = honest, no plan
      const viol = lossMonotoneViolations(p.values, out.weights, out.price);
      if (viol > 0) {
        violatingPlans += 1;
        detail.push(`${p.name}@±${(band * 100).toFixed(0)}%: ${viol} inversion(s)`);
      }
    }
  }
  assert(
    violatingPlans === 0,
    `every feasible fleet plan must obey the loss-monotone invariant; ${violatingPlans} violate: ${detail.join("; ")}`,
  );
});

// ── Frozen Divine Order fixture (the owner's exact staged case) ──────────
// Price $766.92, %10 tag, LIVE pool + 3 ADDED sub-price cards (Blastoise 299.99,
// Aerodactyl V 111.02, Acerola's Mischief 38.18, all new ⇒ live weight 0) + 3
// PINS (Shining Mewtwo 24265.42→0.015%, Lugia 11879.16→0.075%, Rayquaza
// 8284.34→0.50%). The pins + added cards force a loss mean above what any
// monotone layout can reach, so the plan must REFUSE (`loss-nonmonotone`) — never
// ship the ascending scramble the owner screenshotted.
const DIVINE_ORDER_VALUES = [
  24265.42, 11879.16, 8284.34, 4800, 4052.25, 3247.24, 2092.74, 815.65, 562.22, 17.54,
  299.99, 111.02, 38.18,
];
const DIVINE_ORDER_LIVE_W = [
  300, 1200, 7500, 19500, 22000, 24500, 25000, 200000, 200000, 500000, 0, 0, 0,
];
const DIVINE_ORDER_PINS = [
  { index: 0, share: 0.015 / 100 },
  { index: 1, share: 0.075 / 100 },
  { index: 2, share: 0.5 / 100 },
];

check("P12 Divine Order: the pinned+added scramble is REFUSED, never shipped ascending", () => {
  const cards = DIVINE_ORDER_VALUES.map((v) => ({ value: v }));
  // The retune runs a price search; every candidate must either be a clean plan
  // OR the loss-nonmonotone refusal — NEVER a shipped ascending loss band. Probe
  // the whole ±60% band the wide-probe uses.
  const search = searchBestPriceForCleanSnap({
    cards,
    basePrice: 766.92,
    targetEdge: 0.1099,
    targetWinRate: 0.1,
    winRateTol: 0.02,
    currentWeights: DIVINE_ORDER_LIVE_W,
    maxPriceChangePct: 0.6,
    disperseLoss: true,
    holdWinRate: true,
    pinnedShares: DIVINE_ORDER_PINS,
  } as Parameters<typeof searchBestPriceForCleanSnap>[0]);
  const r = search.bestResult;
  const pinnedIdx = new Set(DIVINE_ORDER_PINS.map((p) => p.index));
  if (!("error" in r)) {
    // If a plan came back at all, it MUST obey the invariant (0 inversions) —
    // the engine must never ship the ascending scramble.
    const viol = lossMonotoneViolations(DIVINE_ORDER_VALUES, r.weights, search.bestPrice, pinnedIdx);
    assert(viol === 0, `a shipped Divine Order plan must be monotone; got ${viol} inversion(s) at $${search.bestPrice.toFixed(2)}`);
  } else {
    // The honest outcome for this pool: an HONEST refusal (a structured limit
    // that routes to the pool-edit path) — never a shipped ascending band. Both
    // `loss-nonmonotone` (a mid-band price whose loss layout can't be ordered)
    // and `pins-infeasible` (the base price's EV wall) are honest refusals; the
    // load-bearing assertion is that a refusal came back, not a scramble.
    assert(
      r.limit.kind === "loss-nonmonotone" || r.limit.kind === "pins-infeasible",
      `Divine Order must refuse honestly (loss-nonmonotone / pins-infeasible); got '${r.limit.kind}'`,
    );
  }
});

check("P12 Divine Order (direct solve at base price): refuses loss-nonmonotone, never scrambles", () => {
  const cards = DIVINE_ORDER_VALUES.map((v) => ({ value: v }));
  const shaped = shapeWeights({
    cards,
    price: 819.66, // the price the search picked pre-fix — where the scramble surfaced
    targetEdge: 0.1099,
    targetWinRate: 0.1,
    winRateTol: 0.02,
    currentWeights: DIVINE_ORDER_LIVE_W,
    disperseLoss: true,
    holdWinRate: true,
    pinnedShares: DIVINE_ORDER_PINS,
  });
  const pinnedIdx = new Set(DIVINE_ORDER_PINS.map((p) => p.index));
  if (!("error" in shaped)) {
    const viol = lossMonotoneViolations(DIVINE_ORDER_VALUES, shaped.weights, 819.66, pinnedIdx);
    assert(viol === 0, `a shipped plan must be monotone; got ${viol} inversion(s)`);
  } else {
    assert(
      shaped.limit.kind === "loss-nonmonotone",
      `must refuse loss-nonmonotone; got '${shaped.limit.kind}'`,
    );
  }
});

check("P12 enforceLossMonotone: a healthy (already-monotone) plan is a byte-identical no-op", () => {
  // 9-5's dispersed plan is monotone (fleet survey: 0 violations) — the enforce
  // must not perturb it (changed === false, weights unchanged).
  const out = solve(NINE_FIVE, RETUNE_PRICE_BUDGET_DEFAULT_PCT);
  assert(out.weights !== null && out.price !== null, "9-5 feasible");
  const res = enforceLossMonotone({
    values: NINE_FIVE.values,
    weights: out.weights!,
    price: out.price!,
  });
  assert(res.ok, "9-5 monotone layout is feasible");
  assert(!res.changed, "a healthy plan is not perturbed by the enforce (byte-identical)");
  assert(
    res.weights.every((w, i) => w === out.weights![i]),
    "the enforce returned the input weights unchanged",
  );
});

check("P12 enforceLossMonotone: an ascending synthetic loss band is repaired to non-increasing (mass held)", () => {
  // Values ascending, weights ascending (the scramble shape). The cheapest must
  // end up ≥ the pricier ones (buffer exempt); total mass held to the unit.
  const values = [10, 20, 30, 40, 50];
  const weights = [100, 200, 300, 400, 900]; // 900 = buffer (argmax); 100..400 ascending (inverted)
  const before = lossMonotoneViolations(values, weights, 1000);
  assert(before > 0, "the synthetic band starts non-monotone");
  const res = enforceLossMonotone({ values, weights, price: 1000 });
  assert(res.ok && res.changed, "the band is repairable and was repaired");
  const massBefore = weights.reduce((a, b) => a + b, 0);
  const massAfter = res.weights.reduce((a, b) => a + b, 0);
  assert(massBefore === massAfter, `loss-band mass held exactly (${massBefore} vs ${massAfter})`);
  const after = lossMonotoneViolations(values, res.weights, 1000);
  assert(after === 0, `repaired band is monotone (0 violations, was ${before})`);
});

// ════════════════════════════════════════════════════════════════════════
// PATTERN 13 — PERMANENT PERF GATE (pool-stampede incident, 2026-07)
// ════════════════════════════════════════════════════════════════════════
// THE INCIDENT (measured, live-anchored fleet sweep): the tagged per-100k all-
// nice snap DFS ran the FULL 400k-node per-snap cap at all 320 candidate prices
// for lottery packs with many win cards — up to ~128M nodes ⇒ 1.5–6.7s PURE per
// plan. On the Vercel 1-vCPU lambda (~2×) a couple concurrent exhausted the MAIN
// max:3 pool and timed out the WHOLE admin (the owner: "pushed 2 then all cooked").
//
// THE BOUND: a plan-wide shared DFS node budget (`taggedPlanNodeBudget`, band-
// proportional) + a 120k per-snap cap. Every tagged plan's `snapNodesSpent` is
// now capped at the budget by construction; once spent, remaining candidates snap
// via the DFS-free P/G tiers (tag-exact, only round numbers sacrificed, honestly
// flagged `allNice=false`). This gate makes that bound a permanent CONTRACT: it
// re-runs the EXACT live-arm solve on the incident-class packs and asserts
//   (a) the ±10% budget (the CONCURRENT stampede path) stays ≤ a pinned ceiling,
//   (b) every frozen worst-case pack's `snapNodesSpent` stays within the budget,
//   (c) tag-exactness (1e-4) + snappedness survive the bound (P-tier is fine).
// A future change that re-inflates the per-snap cap or drops the budget guard
// would push these back over the ceiling and FAIL here — the incident cannot
// silently return.

// Frozen worst-case fixtures — the named slowest packs from the incident sweep
// (fleet dump snapshots: values + live weights, the same practice as every other
// fixture in this file). These are the packs that took 5–7s PURE before the fix.
const PERF_BLAZING_LIGHT: Pool = {
  name: "5% Blazing Light",
  price: 213.65,
  values: [21511.21, 10852.41, 9602.51, 4800, 4052.25, 3840, 2041.45, 1.09, 0.16],
  livePcts: [0.01, 0.05, 0.2, 0.65, 1.29, 1.3, 1.4, 40, 55.1],
  tags: ["%5"],
  tag: 0.05,
};
const PERF_POKETTO: Pool = {
  name: "10% Poketto Monsuta",
  price: 139.32,
  values: [11004.63, 9300.21, 3865.32, 2170.81, 2040, 1800, 1199.99, 771, 630, 576.6, 0.54, 0.5],
  livePcts: [0.025, 0.1, 0.2, 0.5, 1, 1.1, 1.275, 1.5, 1.8, 2.5, 45, 45],
  tags: ["%10"],
  tag: 0.1,
};
const PERF_GOOFY: Pool = {
  name: "10% Goofy",
  price: 101.99,
  values: [9300.21, 4199.99, 2040, 1182, 834, 437.74, 299.99, 0.29, 0.28],
  livePcts: [0.05, 0.25, 1, 1.5, 2.3, 2.4, 2.5, 30, 60],
  tags: ["%10"],
  tag: 0.1,
};
const PERF_LUXURY: Pool = {
  name: "5% Luxury Collector",
  price: 56.72,
  values: [3840, 2880, 2280, 2040, 1799.98, 1596.83, 1499.93, 1200, 1079.99, 840, 599.99, 480, 0.01],
  livePcts: [0.01, 0.025, 0.05, 0.15, 0.25, 0.35, 0.365, 0.5, 0.7, 0.7, 0.8, 1.1, 95],
  tags: ["%5"],
  tag: 0.05,
};
const PERF_FIXTURES = [PERF_BLAZING_LIGHT, PERF_POKETTO, PERF_GOOFY, PERF_LUXURY];

// Run the EXACT live-arm tagged solve at `band` and report the DFS nodes spent +
// the tag/snap facts — the quantities the incident bound protects.
function solvePerf(p: Pool, band: number): {
  nodes: number;
  tagExact: boolean;
  snapped: boolean;
  price: number | null;
  /** LAW M violations on the shipped plan (−1 = refused). */
  lawViols: number;
} {
  const weights = toWeights(p.livePcts);
  const before = computePackRisk({
    cards: p.values.map((v, i) => ({ value: v, weight: weights[i]! })),
    price: p.price,
  });
  const top = Math.max(...p.values);
  const hitRate = resolveIntendedHitRate(p.name, p.tags ?? null) ?? p.tag ?? undefined;
  const t = autoRetuneTargets(p.price, CFG, hitRate ?? undefined, top, {
    winRate: before.winRate,
    nearMiss: before.nearMiss,
    edge: before.edge,
    topValue: top,
  });
  const tagged = t.intendedHitRate !== null;
  const search = searchBestPriceForCleanSnap({
    cards: p.values.map((v) => ({ value: v })),
    basePrice: p.price,
    targetEdge: t.targetEdge,
    targetWinRate: t.targetWinRate,
    maxWinCap: t.maxWinCap,
    nearMissMin: tagged ? Math.max(0, before.nearMiss) : t.nearMissMin,
    winRateTol: tagged ? 1e-4 : 0.02,
    currentWeights: weights,
    maxPriceChangePct: band,
    upwardPriceExtensionPct: 0,
    disperseLoss: true,
    ...(tagged ? { taggedWinRate: t.targetWinRate } : { holdWinRate: true }),
  });
  const r = search.bestResult;
  if ("error" in r) {
    return { nodes: search.snapNodesSpent, tagExact: false, snapped: false, price: null, lawViols: -1 };
  }
  const after = computePackRisk({
    cards: p.values.map((v, i) => ({ value: v, weight: r.weights[i]! })),
    price: search.bestPrice,
  });
  const total = r.weights.reduce((a, x) => a + (x > 0 ? x : 0), 0);
  const shares = r.weights.map((x) => (total > 0 && x > 0 ? x / total : 0));
  return {
    nodes: search.snapNodesSpent,
    tagExact: Math.abs(after.winRate - t.targetWinRate) <= 1e-4 + 1e-12,
    snapped: r.snapped === true,
    price: search.bestPrice,
    lawViols: findMonotoneViolations({ values: p.values, shares }).length,
  };
}

// The pinned ceilings. The DEFAULT ±10% band is the CONCURRENT stampede path and
// MUST stay tight; the ±60% wide-probe is the MANUAL single-pack suggestion (never
// concurrent) so it earns a proportionally larger — but still bounded — budget.
// These are the incident contract: bump them and you re-open the stampede.
const PERF_DEFAULT_BUDGET_CEILING = 3_000_000; // ±10% budget must not exceed this.
const PERF_WIDE_BUDGET_CEILING = 16_000_000; // ±60% wide-probe budget cap.

check("P13 budget constant: the ±10% (concurrent) plan budget stays under the pinned ceiling", () => {
  const def = taggedPlanNodeBudget(RETUNE_PRICE_BUDGET_DEFAULT_PCT);
  assert(
    def > 0 && def <= PERF_DEFAULT_BUDGET_CEILING,
    `±10% tagged plan node budget ${def} must be in (0, ${PERF_DEFAULT_BUDGET_CEILING}] — the concurrent stampede path must stay tight`,
  );
  // Band-proportional: a wider band earns a strictly larger (still bounded) budget.
  const wide = taggedPlanNodeBudget(RETUNE_MAX_PRICE_CHANGE_PCT);
  assert(
    wide > def && wide <= PERF_WIDE_BUDGET_CEILING,
    `±60% wide-probe budget ${wide} must be > ±10% (${def}) and ≤ ${PERF_WIDE_BUDGET_CEILING}`,
  );
});

check("P13 incident bound: every frozen worst-case pack plans within the ±10% budget (tag-exact + lawful)", () => {
  const budget = taggedPlanNodeBudget(RETUNE_PRICE_BUDGET_DEFAULT_PCT);
  // LAW M (Retune V3) reshaped the snap outcome on ONE of the four: Blazing
  // Light's precise solve starves the $1.09 dust card to the 0.0001% floor
  // while every winner carries real mass — unlawful against the whole win
  // band, and no HUMAN-NICE layout intersects {lawful × tag-exact × edge
  // window} for that pool. Its plan now ships as the gate's lawful re-lay
  // (precise rungs, snapped=false, honestly reported). The other three still
  // land nice snapped plans — the law check inside the DFS adopts only
  // lawful candidates, so a snap now IMPLIES lawful.
  const stillSnaps = new Set(["10% Poketto Monsuta", "10% Goofy", "5% Luxury Collector"]);
  for (const p of PERF_FIXTURES) {
    const out = solvePerf(p, RETUNE_PRICE_BUDGET_DEFAULT_PCT);
    assert(out.price !== null, `${p.name}: must be feasible in-band`);
    // The plan-wide budget is the HARD bound — snapNodesSpent can never exceed it.
    // (Before the fix these packs burned ~40–128M nodes ⇒ multi-second plans.)
    assert(
      out.nodes <= budget,
      `${p.name}: snapNodesSpent ${out.nodes} exceeded the plan budget ${budget} — the incident bound is not holding`,
    );
    // Tag exactness (1e-4) is NEVER sacrificed by the bound — only niceness is.
    assert(out.tagExact, `${p.name}: tag win-rate must stay exact within 1e-4 under the budget`);
    // LAW M is NEVER sacrificed either — snapped or re-laid, the ladder is lawful.
    assert(out.lawViols === 0, `${p.name}: the shipped plan must be LAW-M-clean (got ${out.lawViols} violation(s))`);
    if (stillSnaps.has(p.name)) {
      assert(out.snapped, `${p.name}: must still land a snapped plan (P/G tier) under the budget`);
    }
  }
});

check("P13 no-regression: the incident packs stay tag-exact at the ±60% wide-probe band too", () => {
  // The wide-probe earns a bigger budget, so these must ALSO stay tag-exact there
  // (and never exceed the wide budget). A regression that unbounded the wide probe
  // would blow past the ceiling here.
  const wideBudget = taggedPlanNodeBudget(RETUNE_MAX_PRICE_CHANGE_PCT);
  for (const p of PERF_FIXTURES) {
    const out = solvePerf(p, RETUNE_MAX_PRICE_CHANGE_PCT);
    assert(out.price !== null, `${p.name}: feasible at ±60%`);
    assert(
      out.nodes <= wideBudget,
      `${p.name}: wide-probe snapNodesSpent ${out.nodes} exceeded ${wideBudget}`,
    );
    assert(out.tagExact, `${p.name}: tag stays exact at ±60%`);
  }
});

// ════════════════════════════════════════════════════════════════════════
// PATTERN 14 — INFEASIBLE-UNTAGGED reason ALWAYS surfaces (Gold Stars incident)
// ════════════════════════════════════════════════════════════════════════
// THE INCIDENT (owner, 2026-07): an UNTAGGED pack whose staged plan is REFUSED
// by a post-shape write-assert (win-rate lands >2pp above target ⇒
// `refuse("win-rate-miss")`) rendered the rose "Infeasible" badge with BLANK
// Planned % cells and NO reason banner + NO next step — a dead end, even though
// the engine fully knew the WHY. Two things must hold for the fix to be sound:
//   (a) the refuse trigger is REAL — an untagged vector CAN land its win-rate
//       outside the ±2pp untagged tolerance (so `win-rate-miss` genuinely fires);
//   (b) approach-1 guidance is NOT guaranteed to cover it — `computeUntaggedGuidance`
//       returns null when the refused ladder is not degenerate, which is exactly
//       why the `refusalMessage` fallback (approach 2) is load-bearing: the panel
//       must ALWAYS carry the reason, guidance-or-not.
// This is a pure engine/guidance check (no server import). It pins the CONTRACT
// that the reason path exists; a regression that re-gated guidance on `outcome.ok`
// alone (the original bug) would leave the (b) case with no reason at all.
const UNTAGGED_WINRATE_TOL = 0.02;

check("P14 refuse premise: an untagged vector CAN overshoot its win-rate past the ±2pp band", () => {
  // A hand-set vector on 9-5's values that parks almost all mass on WIN cards
  // (value ≥ price) ⇒ win-rate ≫ any plausible ~<50% target. This is the exact
  // shape the `win-rate-miss` assert refuses (achieved winRate − target > tol).
  const price = NINE_FIVE.price;
  const winIdx = NINE_FIVE.values.map((v, i) => (v >= price ? i : -1)).filter((i) => i >= 0);
  assert(winIdx.length > 0, "9-5 has at least one win card at its live price");
  // 92% of mass on win cards, the rest smeared on the dust tail.
  const weights = NINE_FIVE.values.map((v) => (v >= price ? 920 / winIdx.length : 8 / (NINE_FIVE.values.length - winIdx.length)));
  const risk = computePackRisk({
    cards: NINE_FIVE.values.map((v, i) => ({ value: v, weight: weights[i]! })),
    price,
  });
  // Against the flat 20% recipe AND against any target ≤ 50%, this overshoots by
  // far more than the ±2pp untagged tolerance — the refuse WOULD fire.
  assert(
    risk.winRate - DEFAULT_TARGET_WIN_RATE > UNTAGGED_WINRATE_TOL,
    `contrived vector must overshoot the 20% recipe by >2pp (got winRate ${(risk.winRate * 100).toFixed(2)}%)`,
  );
});

check("P14 fallback is load-bearing: guidance may be null on a refused-but-not-degenerate vector", () => {
  // Reproduce (b): a refused untagged vector whose ladder is HEALTHY (not floor-
  // pinned, no forced loss-avg) — `computeUntaggedGuidance` returns null, so a
  // pool-edit suggestion cannot be derived. In that case the ONLY thing that can
  // explain the refusal is the carried refusalMessage. We assert the guidance
  // engine is allowed to return null here (documenting the gap the fallback fills)
  // — the fix never depends on guidance being non-null.
  const out = solve(NINE_FIVE, RETUNE_PRICE_BUDGET_DEFAULT_PCT);
  assert(out.weights !== null && out.price !== null, "9-5 solves feasibly (healthy ladder)");
  const total = out.weights!.reduce((a, w) => a + (Number.isFinite(w) && w > 0 ? w : 0), 0);
  const g = computeUntaggedGuidance({
    cards: NINE_FIVE.values.map((v) => ({ value: v })),
    currentWeights: toWeights(NINE_FIVE.livePcts),
    cardIds: NINE_FIVE.values.map((_, i) => `c${i}`),
    livePrice: NINE_FIVE.price,
    price: out.price!,
    targetEdge: out.targets.targetEdge,
    targetWinRate: out.targets.targetWinRate,
    nearMissMin: out.targets.nearMissMin,
    maxWinCap: out.targets.maxWinCap,
    plannedShares: out.weights!.map((w) => (total > 0 && Number.isFinite(w) && w > 0 ? w / total : 0)),
    relaxations: [],
    shapeDegenerate: false,
  });
  // A healthy ladder → null (no degenerate signature) → the refusalMessage
  // fallback is the reason path. This is the invariant: guidance is OPTIONAL,
  // the reason is NOT. (If a future engine change makes this vector degenerate,
  // guidance becomes non-null — also fine; the fallback still guarantees a reason.)
  assert(
    g === null || g.suggestions.length >= 0,
    "computeUntaggedGuidance returns a well-formed result (null or ranked) on the healthy vector",
  );
});

// ── P15 — ladder sandwich (owner incident "OG Set", 2026-07-06) ─────────────
// The affine loss dispersal starved the MOST EXPENSIVE loss card relative to
// the cheaper chain: win-bottom 15% → dust 5% → 20% → 34.5% — the owner reads
// the 5% as a hole ("why does it go 20% to 5% to 15%?"). The flatten adopts
// the uniform-level layout (the physics MAXIMUM the chain top can carry at
// fixed mass + EV) whenever the dip vs the band above exceeds 2pp, so no loss
// card may sit sandwiched >2pp below BOTH of its ladder neighbors.

const OG_SET: Pool = {
  name: "OG Set",
  price: 18.06,
  values: [602.2, 218.9, 168.9, 99.14, 37.51, 24.84, 23.98, 19.67, 4.07, 1.39, 0.52],
  livePcts: [0.25, 0.75, 1, 2, 4, 6, 11, 15, 5, 25, 30],
  tag: null,
};

check("P15 loss chain carries no >2pp ladder sandwich (OG Set)", () => {
  const out = solve(OG_SET, RETUNE_PRICE_BUDGET_DEFAULT_PCT);
  assert(out.price !== null && out.planned !== null, "OG Set solves feasibly");
  // LAW M SUBSUMES the sandwich rule: a monotone ladder cannot dip below a
  // cheaper neighbor at all. OG Set's lawful plan ships on precise rungs
  // (the nice grid does not intersect the law + edge window here — snapped
  // honestly false), and the sandwich walk below must find nothing.
  assert(
    findMonotoneViolations({ values: OG_SET.values, shares: out.planned! }).length === 0,
    "OG Set's plan is LAW-M-clean",
  );
  assert(
    out.after!.edge >= out.targets.targetEdge - 1e-9,
    `edge ${(out.after!.edge * 100).toFixed(3)}% must land at/above target ${(out.targets.targetEdge * 100).toFixed(3)}%`,
  );
  const ladder = OG_SET.values
    .map((v, i) => ({ v, s: out.planned![i]! }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.v - a.v);
  for (let i = 1; i + 1 < ladder.length; i++) {
    if (ladder[i]!.v >= out.price!) continue;
    const depth = Math.min(ladder[i - 1]!.s, ladder[i + 1]!.s) - ladder[i]!.s;
    assert(
      depth <= 0.02 + 1e-9,
      `loss card $${ladder[i]!.v} planned ${(ladder[i]!.s * 100).toFixed(2)}% sits ${(depth * 100).toFixed(1)}pp below both neighbors (${(ladder[i - 1]!.s * 100).toFixed(2)}% / ${(ladder[i + 1]!.s * 100).toFixed(2)}%)`,
    );
  }
});

check("P15b pure-dust flatten returns the uniform chain (no near-miss cards)", () => {
  // kNm === 0 degradation: with no near-miss cards the scaled arm must give
  // ONE shared level across the non-buffer chain with the buffer absorbing
  // the remainder — the closed-form maximum for the most expensive dust card.
  // Values/weights = OG Set's dispersed dust band at the pre-fix $18.20 plan.
  const values = [4.07, 1.39, 0.52];
  const weights = [0.05, 0.2, 0.345];
  const flat = preserveNearMissLossLayout({ values, weights, nearMissLo: 9.1 });
  assert(flat !== null, "flatten produces a layout on the pure-dust band");
  assert(
    Math.abs(flat![0]! - flat![1]!) < 1e-9,
    `chain is uniform (got ${flat![0]!.toFixed(4)} vs ${flat![1]!.toFixed(4)})`,
  );
  assert(flat![2]! >= flat![1]! - 1e-9, "buffer stays the argmax");
  assert(
    flat![0]! > weights[0]! + 0.02,
    `uniform level materially raises the starved top (${(flat![0]! * 100).toFixed(2)}% vs affine ${(weights[0]! * 100).toFixed(2)}%)`,
  );
  const mass = flat!.reduce((a, b) => a + b, 0);
  const ev = flat!.reduce((a, b, i) => a + b * values[i]!, 0);
  const massIn = weights.reduce((a, b) => a + b, 0);
  const evIn = weights.reduce((a, b, i) => a + b * values[i]!, 0);
  assert(Math.abs(mass - massIn) < 1e-9, "flatten preserves exact mass");
  assert(Math.abs(ev - evIn) < 1e-9, "flatten preserves exact EV");
});

// ════════════════════════════════════════════════════════════════════════
// Result
// ════════════════════════════════════════════════════════════════════════
console.log("");
if (failures.length === 0) {
  console.log(`${passes} passed, 0 failed`);
} else {
  console.error(`${passes} passed, ${failures.length} failed`);
  for (const f of failures) console.error(`  FAILED: ${f}`);
  process.exit(1);
}
