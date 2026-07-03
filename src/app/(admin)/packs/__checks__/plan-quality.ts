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
  computePackRisk,
  snapWeightsToCleanLadder,
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
function solve(p: Pool, band: number): SolveOut {
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
    ...(tagged ? { taggedWinRate: t.targetWinRate } : {}),
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
 * carries the exact residual (49.985% = weight 499850); the non-buffer snapped
 * to the clean 50% rung (weight 500000). Returns 1 or 2, or -1 if the layout
 * doesn't match the fixture (a guard against a silent snap change).
 */
function bufferIndex(snap: { weights: number[] }): number {
  const w1 = snap.weights[1];
  const w2 = snap.weights[2];
  const isResidual = (w: number | undefined): boolean => w === 499850;
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

check("P1 detection: the owner's degenerate pools (Captive, Tails?) read DEGENERATE at ±10%", () => {
  for (const p of [CAPTIVE, TAILS]) {
    const out = solve(p, RETUNE_PRICE_BUDGET_DEFAULT_PCT);
    assert(out.price !== null && out.planned !== null, `${p.name} must be feasible in-band`);
    const s = ladderShape(p.values, toShares(p.livePcts), out.planned!, out.price!);
    assert(s.degenerate, `${p.name}: the shape guard must flag the collapse (score ${s.score.toFixed(3)})`);
  }
});

check("P1 detection: a degenerate plan trips crush-guard OR carrier-guard (the flag has teeth)", () => {
  for (const p of [CAPTIVE, TAILS]) {
    const out = solve(p, RETUNE_PRICE_BUDGET_DEFAULT_PCT);
    assert(out.planned !== null && out.price !== null, `${p.name} feasible`);
    const crushed = crushGuardViolations(p, out.planned!);
    const carrier = carrierExcessPp(p, out.planned!, out.price!);
    assert(
      crushed > 0 || carrier > 25,
      `${p.name}: degenerate plan must violate crush (${crushed}) or carrier (+${carrier.toFixed(1)}pp) guard`,
    );
  }
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
