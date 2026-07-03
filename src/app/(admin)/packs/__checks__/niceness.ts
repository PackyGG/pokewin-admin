/**
 * SNAP-NICENESS harness (pure, no DB) — the tagged HUMAN-NICE rung grid.
 *
 * Run with:
 *   npx tsx "src/app/(admin)/packs/__checks__/niceness.ts"
 *
 * Pins every contract of the snap-niceness spec (tagged three-tier snap +
 * niceness preference tier in the price search + the Rule Set fix), with all
 * fixtures RE-DERIVED against the pins-generalized engine (a46722c4 base —
 * the BEFORE numbers reproduced bit-exact on it before this feature landed):
 *
 *   1.  NICE_UNITS grid = exactly the 42-element {1,1.5,2,2.5,3,3.5,4,5,7.5}
 *       ×10^k integer per-100k set; isOnNiceGridPct spot checks (95%/90% are
 *       NOT on the grid — they are legal only via the buffer exemption).
 *   2.  F1 — Lucky Pond staged @ 5% (the owner complaint): $1.82, all-nice
 *       [350,400,500,500,750,2500,95000] bit-exact + the band facts (404
 *       all-nice assignments, 37 tag-exact cents 152–188, 65 pairs, $1.82
 *       the unique nearest all-nice cent) + the live-cap basis probe
 *       (jackpot 350 ≤ live 368.4 but > precise 133 — the OLD precise-based
 *       guard would have rejected the owner's own ask).
 *   3.  F2 — Lucky Pond @ 10%: $2.69 all-nice bit-exact; the UNIQUE all-nice
 *       (assignment, cent) pair in the whole band (74 tag-exact cents
 *       243–316) — proves the niceTier guard keeps the search hunting past
 *       the nearer per-100k-exact $2.44 (tier ordering: all-nice beats
 *       grid-exact at larger centsDist).
 *   4.  F3 — SYN-A: base-cent all-nice [50,200,750,4000,95000] bit-exact,
 *       searched=1 (early return now requires niceTier 0) + the deterministic
 *       tie-break (dust rung 3500 vs 4000, equal shape distance → min edge
 *       excess picks 4000; the precise dust share is far from 4000 — pins the
 *       non-buffer dust rung ENUMERATION, not nearest-rounding).
 *   5.  F4 — SYN-B "pinned" (property asserts): feasible + snapped + tag
 *       exact + edge in the one-sided window + allNice=false with EXACTLY
 *       the absorber off-nice (tier P won over tier G) + caps respected +
 *       the honesty-banner copy exists verbatim in plan-copy.ts. Zero
 *       all-nice completions exist (combinatorial proof re-run inline).
 *   6.  F5 — Rule Set: price-independent no-dust refusal, searched=1
 *       (pre-check), priceIndependent=true, exact detail substitutions.
 *   7.  Edge window (§9.6): at a tag-exact cent where every all-nice
 *       completion violates the window ($1.88), NO tier surfaces it — the
 *       engine falls through honestly (unsnapped precise, edge in window).
 *   8.  Untagged golden: byte-identical before/after (verified against the
 *       pristine a46722c4 engine at build time) — niceTier + grid changes
 *       are tagged-only.
 *   9.  Pins interplay: a pinned win card's units survive the snap verbatim,
 *       are excluded from the niceness accounting, and the unpinned win band
 *       absorbs exactly W − pinned.
 *  10.  Determinism (F1 + F3 run twice, byte-identical) + perf (one F1
 *       search ≤ 3 s).
 *
 * Exit code 0 = all passed; 1 = at least one failure (printed).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  ONE_SIDED_EDGE_EXCESS_TOL,
  RETUNE_MAX_PRICE_CHANGE_PCT,
  TAGGED_WINRATE_TOLERANCE,
  countOffNicePct,
  isOnNiceGridPct,
  searchBestPriceForCleanSnap,
  shapeWeights,
  type SearchBestPriceResult,
  type ShapeWeightsResult,
  type ShapeWeightsSuccess,
} from "../../insights/edge-calc/risk";
import {
  autoRetuneTargets,
  type ResolvedAutoTargetCfg,
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

function assertSuccess(r: ShapeWeightsResult, label: string): ShapeWeightsSuccess {
  if ("error" in r) {
    throw new Error(`${label}: expected success, got ${r.limit.kind} — ${r.error}`);
  }
  return r;
}

// ── Fixture pools (engine-verified constants — no DB) ────────────────────

const cfg: ResolvedAutoTargetCfg = { globalCap: 25000, maxMultCeiling: 100 };

/** Lucky Pond STAGED pool (live pool minus the $2.36 card), base $1.98. */
const LP_VALUES = [46.3, 29.99, 28.91, 22.16, 19.98, 16.76, 0.54];
const LP_LIVE_W = [3500, 5000, 6000, 7500, 13000, 15000, 900000];
const LP_LIVE_TOTAL = 950000;
const LP_BASE = 1.98;

function runTaggedSearch(
  values: number[],
  liveW: number[],
  basePrice: number,
  tag: number,
): SearchBestPriceResult {
  const auto = autoRetuneTargets(basePrice, cfg, tag, Math.max(...values));
  return searchBestPriceForCleanSnap({
    cards: values.map((v) => ({ value: v })),
    basePrice,
    targetEdge: auto.targetEdge,
    targetWinRate: tag,
    maxWinCap: auto.maxWinCap,
    nearMissMin: 0,
    winRateTol: TAGGED_WINRATE_TOLERANCE,
    currentWeights: liveW,
    maxPriceChangePct: RETUNE_MAX_PRICE_CHANGE_PCT,
    upwardPriceExtensionPct: 0,
    taggedWinRate: tag,
  });
}

/**
 * Arithmetic ALL-NICE enumerator over the Lucky Pond win band — mirrors the
 * engine's tier-N constraints exactly (nice units, sum = W, monotone
 * non-decreasing units walking cheaper, live caps on every non-cheapest win
 * card, cheapest uncapped, single dust card = the exact residual). Used to
 * RE-DERIVE the spec's band facts rather than trusting them.
 */
const NICE_UNITS_EXPECTED: number[] = [
  1, 2, 3, 4, 5, 10, 15, 20, 25, 30, 35, 40, 50, 75, 100, 150, 200, 250, 300,
  350, 400, 500, 750, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 5000, 7500,
  10000, 15000, 20000, 25000, 30000, 35000, 40000, 50000, 75000, 100000,
];

function enumerateLpAllNice(W: number): { u: number[]; ev: number }[] {
  const caps = LP_LIVE_W.map((w) => (w / LP_LIVE_TOTAL) * 100000);
  const M = 6; // win cards (value-DESC = pool order here)
  const out: { u: number[]; ev: number }[] = [];
  const u = new Array<number>(M).fill(0);
  const dfs = (i: number, prev: number, sum: number): void => {
    if (i === M) {
      if (sum !== W) return;
      const winEv = u.reduce((a, r, k) => a + r * LP_VALUES[k]!, 0);
      out.push({ u: u.slice(), ev: (winEv + (100000 - W) * LP_VALUES[6]!) / 100000 });
      return;
    }
    const cap = i === M - 1 ? W : caps[i]!;
    for (const r of NICE_UNITS_EXPECTED) {
      if (r < prev) continue;
      if (r > cap + 1e-9) break;
      if (sum + r * (M - i) > W) break;
      u[i] = r;
      dfs(i + 1, r, sum + r);
    }
  };
  dfs(0, 0, 0);
  return out;
}

/** Cents in the ±60% band where the PRECISE solve lands tag-exact. */
function lpTagExactCents(tag: number): number[] {
  const auto = autoRetuneTargets(LP_BASE, cfg, tag, Math.max(...LP_VALUES));
  const span = Math.floor(LP_BASE * RETUNE_MAX_PRICE_CHANGE_PCT * 100);
  const lo = Math.round(LP_BASE * 100) - span;
  const hi = Math.round(LP_BASE * 100) + span;
  const cents: number[] = [];
  for (let c = lo; c <= hi; c++) {
    const r = shapeWeights({
      cards: LP_VALUES.map((v) => ({ value: v })),
      price: c / 100,
      targetEdge: auto.targetEdge,
      targetWinRate: tag,
      maxWinCap: auto.maxWinCap,
      nearMissMin: 0,
      winRateTol: TAGGED_WINRATE_TOLERANCE,
      currentWeights: LP_LIVE_W,
      winRateIsHard: true,
    });
    if ("weights" in r && Math.abs(r.risk.winRate - tag) <= TAGGED_WINRATE_TOLERANCE) {
      cents.push(c);
    }
  }
  return cents;
}

/** (assignment, cent) pairs whose edge lands in [target, target+0.001]. */
function lpAllNicePairs(
  tag: number,
  assignments: { u: number[]; ev: number }[],
  exactCents: number[],
): { cents: number; u: number[] }[] {
  const auto = autoRetuneTargets(LP_BASE, cfg, tag, Math.max(...LP_VALUES));
  const exact = new Set(exactCents);
  const pairs: { cents: number; u: number[] }[] = [];
  for (const a of assignments) {
    const pLo = a.ev / (1 - auto.targetEdge);
    const pHi = a.ev / (1 - auto.targetEdge - 0.001);
    const cLo = Math.ceil(pLo * 100 - 1e-9);
    const cHi = Math.floor(pHi * 100 + 1e-9);
    for (let c = cLo; c <= cHi; c++) {
      if (exact.has(c)) pairs.push({ cents: c, u: a.u });
    }
  }
  return pairs;
}

// ── 1. The NICE grid itself ──────────────────────────────────────────────

check("NICE grid: isOnNiceGridPct accepts exactly the 42-unit snapshot over 1..100000", () => {
  const got: number[] = [];
  for (let units = 1; units <= 100000; units++) {
    if (isOnNiceGridPct(units / 1000)) got.push(units);
  }
  assert(
    JSON.stringify(got) === JSON.stringify(NICE_UNITS_EXPECTED),
    `grid drifted: ${got.length} units (expected ${NICE_UNITS_EXPECTED.length}) — got [${got.join(",")}]`,
  );
});

check("NICE grid: spot checks (0.35/0.05/2.5/0.001/3.5 in; 0.047/0.234/3.48/95/90/0.0005/0.006/0.0095 out)", () => {
  for (const pct of [0.35, 0.05, 2.5, 0.001, 3.5]) {
    assert(isOnNiceGridPct(pct), `${pct}% must be nice`);
  }
  // 95% / 90% are NOT nice (mantissa 9/9.5) — the buffer EXEMPTION is what
  // makes them legal on real plans (asserted on F1 below), not the grid.
  for (const pct of [0.047, 0.234, 3.48, 95.0, 90.0, 0.0005, 0.006, 0.0095]) {
    assert(!isOnNiceGridPct(pct), `${pct}% must NOT be nice`);
  }
});

// ── 2. F1 — Lucky Pond @ 5% (the owner complaint, bit-exact) ─────────────

const F1_EXPECT = [350, 400, 500, 500, 750, 2500, 95000];
let f1: SearchBestPriceResult | null = null;

check("F1: Lucky Pond 5% → $1.82, all-nice [350,400,500,500,750,2500,95000] bit-exact", () => {
  const t0 = Date.now();
  f1 = runTaggedSearch(LP_VALUES, LP_LIVE_W, LP_BASE, 0.05);
  const elapsed = Date.now() - t0;
  const r = assertSuccess(f1.bestResult, "F1");
  assert(Math.round(f1.bestPrice * 100) === 182, `bestPrice $${f1.bestPrice} ≠ $1.82`);
  assert(
    JSON.stringify(r.weights) === JSON.stringify(F1_EXPECT),
    `weights [${r.weights.join(",")}]`,
  );
  assert(r.snapped === true, "snapped");
  assert(r.allNice === true, `allNice=${r.allNice}`);
  assert(f1.taggedAccuracyHit === true, "taggedAccuracyHit");
  assert(
    Math.abs(r.risk.winRate - 0.05) <= 1e-12,
    `winRate ${(r.risk.winRate * 100).toFixed(6)}% must be exactly 5%`,
  );
  const targetEdge = autoRetuneTargets(LP_BASE, cfg, 0.05, 46.3).targetEdge;
  assert(
    r.edge >= targetEdge - 1e-9 && r.edge <= targetEdge + 0.001 + 1e-9,
    `edge ${(r.edge * 100).toFixed(4)}% outside [target, target+0.1pp]`,
  );
  // Exemption path: ONLY the dust buffer (index 6, 95% — off the grid but
  // exempt by design) — no pins, no forced single winner.
  assert(
    JSON.stringify(r.niceExemptIdx) === JSON.stringify([6]),
    `niceExemptIdx ${JSON.stringify(r.niceExemptIdx)}`,
  );
  assert(countOffNicePct(r.weights, r.niceExemptIdx) === 0, "off-nice count 0");
  // Perf gate (§9.10): one full tagged search ≤ 3 s.
  assert(elapsed <= 3000, `F1 search took ${elapsed}ms > 3000ms`);
});

check("F1: live-cap basis probe — jackpot 350 ≤ live 368.4 AND > precise 133 (the OLD precise guard would reject)", () => {
  assert(f1 !== null, "F1 must have run");
  const r = assertSuccess(f1.bestResult, "F1");
  const liveCapUnits = (LP_LIVE_W[0]! / LP_LIVE_TOTAL) * 100000; // 368.42
  assert(r.weights[0]! <= liveCapUnits + 1e-9, `jackpot ${r.weights[0]} > live cap ${liveCapUnits}`);
  // Precise jackpot at $1.82 = 133.0 per-100k units (re-derived 2026-07-03 on
  // a46722c4: the pre-niceness engine's unsnapped fallback at $1.82 was
  // [1330, 5263, 6038, 7895, 13684, 15789, 950000] / 999999 total).
  assert(r.weights[0]! > 133.0, `jackpot ${r.weights[0]} must exceed the precise 133 units`);
});

check("F1: band facts re-derived — 404 all-nice assignments; 37 tag-exact cents (152–188); 65 pairs; $1.82 the unique nearest", () => {
  const assignments = enumerateLpAllNice(5000);
  assert(assignments.length === 404, `assignments ${assignments.length} ≠ 404`);
  const exact = lpTagExactCents(0.05);
  assert(
    exact.length === 37 && exact[0] === 152 && exact[exact.length - 1] === 188,
    `tag-exact cents ${exact.length} [${exact[0]}..${exact[exact.length - 1]}] ≠ 37 [152..188]`,
  );
  const pairs = lpAllNicePairs(0.05, assignments, exact);
  assert(pairs.length === 65, `pairs ${pairs.length} ≠ 65`);
  let best = Infinity;
  for (const p of pairs) best = Math.min(best, Math.abs(p.cents - 198));
  const nearest = pairs.filter((p) => Math.abs(p.cents - 198) === best);
  assert(
    nearest.length === 1 && nearest[0]!.cents === 182,
    `nearest all-nice cent must be uniquely 182 (got ${nearest.map((p) => p.cents).join(",")})`,
  );
  assert(
    JSON.stringify(nearest[0]!.u) === JSON.stringify(F1_EXPECT.slice(0, 6)),
    `the unique $1.82 assignment must be the F1 vector (got [${nearest[0]!.u.join(",")}])`,
  );
});

// ── 3. F2 — Lucky Pond @ 10% (unique pair; niceTier keeps hunting) ───────

const F2_EXPECT = [250, 250, 500, 750, 750, 7500, 90000];

check("F2: Lucky Pond 10% → $2.69 (Δ+71¢ past the grid-exact $2.44), all-nice bit-exact", () => {
  const s = runTaggedSearch(LP_VALUES, LP_LIVE_W, LP_BASE, 0.1);
  const r = assertSuccess(s.bestResult, "F2");
  assert(Math.round(s.bestPrice * 100) === 269, `bestPrice $${s.bestPrice} ≠ $2.69`);
  assert(
    JSON.stringify(r.weights) === JSON.stringify(F2_EXPECT),
    `weights [${r.weights.join(",")}]`,
  );
  assert(r.snapped === true && r.allNice === true, "snapped all-nice");
  assert(Math.abs(r.risk.winRate - 0.1) <= 1e-12, "winRate exactly 10%");
  assert(s.taggedAccuracyHit === true, "taggedAccuracyHit");
  // Tier ordering: without the niceTier the search would have settled at the
  // nearer per-100k-exact $2.44 (the BEFORE pick) — all-nice outranks
  // centsDist below snappedness.
  assert(Math.round(s.bestPrice * 100) !== 244, "must not settle at the grid-exact $2.44");
});

check("F2: band facts re-derived — the $2.69 pair is the UNIQUE all-nice pair (74 tag-exact cents 243–316)", () => {
  const assignments = enumerateLpAllNice(10000);
  assert(assignments.length === 32, `assignments ${assignments.length} ≠ 32`);
  const exact = lpTagExactCents(0.1);
  assert(
    exact.length === 74 && exact[0] === 243 && exact[exact.length - 1] === 316,
    `tag-exact cents ${exact.length} [${exact[0]}..${exact[exact.length - 1]}] ≠ 74 [243..316]`,
  );
  const pairs = lpAllNicePairs(0.1, assignments, exact);
  assert(pairs.length === 1 && pairs[0]!.cents === 269, `pairs must be exactly {269} (got ${pairs.length})`);
  assert(
    JSON.stringify(pairs[0]!.u) === JSON.stringify(F2_EXPECT.slice(0, 6)),
    `the unique assignment must be the F2 vector`,
  );
});

// ── 4. F3 — SYN-A (base-cent all-nice + deterministic tie-break) ─────────

const SYNA_VALUES = [600, 150, 60, 0.3, 0.1];
const SYNA_LIVE_W = [90, 380, 530, 15000, 84000];
const F3_EXPECT = [50, 200, 750, 4000, 95000];

function runSynA(): SearchBestPriceResult {
  return runTaggedSearch(SYNA_VALUES, SYNA_LIVE_W, 1.3, 0.01);
}

check("F3: SYN-A → $1.30 (Δ0, searched=1 early return), [50,200,750,4000,95000] bit-exact", () => {
  const s = runSynA();
  const r = assertSuccess(s.bestResult, "F3");
  assert(Math.round(s.bestPrice * 100) === 130, `bestPrice $${s.bestPrice}`);
  assert(s.searched === 1, `searched=${s.searched} — the all-nice base must early-return`);
  assert(
    JSON.stringify(r.weights) === JSON.stringify(F3_EXPECT),
    `weights [${r.weights.join(",")}]`,
  );
  assert(r.snapped === true && r.allNice === true, "snapped all-nice");
  assert(Math.abs(r.risk.winRate - 0.01) <= 1e-12, "winRate exactly 1%");
  assert(Math.abs(r.edge - 0.11) <= 1e-9, `edge ${(r.edge * 100).toFixed(4)}% ≠ 11.0000%`);
});

check("F3: tie-break pin — dust rung 3500 vs 4000 are shape-equal; min edge excess picks 4000", () => {
  // Both candidates share the win assignment [50,200,750] (same shape
  // distance); only the enumerated non-buffer dust rung differs. Selection
  // key #3 (smallest house-favorable excess) must pick 4000.
  const target = autoRetuneTargets(1.3, cfg, 0.01, 600).targetEdge;
  const evOf = (dust: number): number =>
    (50 * 600 + 200 * 150 + 750 * 60 + dust * 0.3 + (100000 - 1000 - dust) * 0.1) / 100000;
  const edge3500 = 1 - evOf(3500) / 1.3;
  const edge4000 = 1 - evOf(4000) / 1.3;
  assert(edge3500 >= target - 1e-9 && edge3500 <= target + 0.001 + 1e-9, "3500 must be in-window too");
  assert(edge4000 >= target - 1e-9 && edge4000 <= target + 0.001 + 1e-9, "4000 must be in-window");
  assert(
    edge4000 - target < edge3500 - target,
    "4000 must carry the smaller excess (the deterministic pick)",
  );
  // The precise dust share sits nowhere near 4000 units — nearest-rounding
  // could never reach it; only the rung ENUMERATION can.
});

// ── 5. F4 — SYN-B "pinned" (saturation honesty, property asserts) ────────

const SYNB_VALUES = [6000, 1500, 450, 0.6];
const SYNB_LIVE_W = [47, 234, 719, 99000];

check("F4: SYN-B → snapped, tag exact, edge in window, allNice=false with EXACTLY the absorber off-nice", () => {
  const s = runTaggedSearch(SYNB_VALUES, SYNB_LIVE_W, 8.0, 0.01);
  const r = assertSuccess(s.bestResult, "F4");
  const target = autoRetuneTargets(8.0, cfg, 0.01, 6000).targetEdge;
  assert(r.snapped === true, "snapped");
  assert(s.taggedAccuracyHit === true, "taggedAccuracyHit");
  assert(Math.abs(r.risk.winRate - 0.01) <= TAGGED_WINRATE_TOLERANCE + 1e-12, "tag exact");
  assert(
    r.edge >= target - 1e-9 && r.edge <= target + 0.0035 + 1e-9,
    `edge ${(r.edge * 100).toFixed(4)}% outside [target, target+0.35pp]`,
  );
  assert(r.allNice === false, `allNice=${r.allNice} — the saturated pool cannot land all-nice`);
  const off = countOffNicePct(r.weights, r.niceExemptIdx);
  assert(off === 1, `off-nice count ${off} — tier P must win with exactly the absorber off (tier G would leave ≥ 2)`);
  // Never-inflate: every non-cheapest winner ≤ its live cap.
  const total = r.weights.reduce((a, b) => a + (b > 0 ? b : 0), 0);
  const liveTotal = SYNB_LIVE_W.reduce((a, b) => a + b, 0);
  for (let i = 0; i < 2; i++) {
    const after = (r.weights[i]! / total) * 100000;
    const cap = (SYNB_LIVE_W[i]! / liveTotal) * 100000;
    assert(after <= cap + 1e-6, `win card ${i}: ${after} units > live cap ${cap}`);
  }
});

check("F4: combinatorial proof — ZERO all-nice completions exist under the caps (price-free)", () => {
  // u1 ≤ 47 nice, u2 ∈ [u1, 234] nice, u3 = 1000 − u1 − u2 nice and ≥ u2.
  const niceLe = (cap: number) => NICE_UNITS_EXPECTED.filter((r) => r <= cap);
  let completions = 0;
  for (const u1 of niceLe(47)) {
    for (const u2 of niceLe(234)) {
      if (u2 < u1) continue;
      const u3 = 1000 - u1 - u2;
      if (u3 < u2) continue;
      if (NICE_UNITS_EXPECTED.includes(u3)) completions += 1;
    }
  }
  assert(completions === 0, `expected 0 all-nice completions, found ${completions}`);
});

check("F4: the honesty-banner copy exists verbatim in plan-copy.ts (push stays enabled)", () => {
  const copyPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../(pack-studio)/pack-studio/retune/_workspace/plan-copy.ts",
  );
  const src = readFileSync(copyPath, "utf8");
  assert(src.includes("export function nicePinnedBanner"), "nicePinnedBanner missing");
  assert(
    src.includes(
      "odds can't land on round numbers at any price in the band: the tag and the never-inflate caps pin this pool too tightly. Fine to push — tag and edge are exact.",
    ),
    "the exact banner copy drifted",
  );
  const panelPath = path.resolve(path.dirname(copyPath), "plan-panel.tsx");
  const panel = readFileSync(panelPath, "utf8");
  assert(
    panel.includes("plan.snapped === true && plan.allNice === false"),
    "plan-panel must gate the banner on snapped && !allNice",
  );
  assert(panel.includes("nicePinnedBanner(plan.offLadderCards.length"), "banner must render the off count");
});

// ── 6. F5 — Rule Set (price-independent no-dust, searched=1) ─────────────

check("F5: Rule Set → no-dust-cards, priceIndependent=true, searched=1, exact substitutions", () => {
  const values = [35.64, 26.52, 24.49, 23.59, 18.85];
  const auto = autoRetuneTargets(26.95, cfg, undefined, 35.64);
  const s = searchBestPriceForCleanSnap({
    cards: values.map((v) => ({ value: v })),
    basePrice: 26.95,
    targetEdge: auto.targetEdge,
    targetWinRate: auto.targetWinRate,
    maxWinCap: auto.maxWinCap,
    nearMissMin: auto.nearMissMin,
    winRateTol: 0.02,
    currentWeights: [100000, 150000, 200000, 250000, 300000],
    maxPriceChangePct: RETUNE_MAX_PRICE_CHANGE_PCT,
    upwardPriceExtensionPct: 0,
  });
  assert(s.searched === 1, `searched=${s.searched} ≠ 1 — the pre-check must fire (was 120)`);
  assert(s.fellBackToBase === true, "fellBackToBase");
  const r = s.bestResult;
  assert("error" in r, "must be the error arm");
  assert(r.limit.kind === "no-dust-cards", `kind ${r.limit.kind}`);
  assert(r.limit.priceIndependent === true, "priceIndependent must be true");
  for (const frag of ["$13.47", "$26.95", "$18.85", "$35.64", "no price can create one", "Only a pool edit fixes this."]) {
    assert(r.limit.detail.includes(frag), `detail must contain "${frag}" — got: ${r.limit.detail}`);
  }
  assert(
    r.limit.suggestedRange !== undefined &&
      r.limit.suggestedRange.min === 0 &&
      Math.abs(r.limit.suggestedRange.max - 13.475) < 1e-9,
    "suggestedRange {0, 13.475} CTA must stay intact",
  );
  // The plain-words headline for the price-free case lives in plan-copy.
  const copyPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../(pack-studio)/pack-studio/retune/_workspace/plan-copy.ts",
  );
  const src = readFileSync(copyPath, "utf8");
  assert(
    src.includes("No price works here — every card sits too close to the ticket."),
    "the price-free headline copy drifted",
  );
});

// ── 7. §9.6 — an edge-window-violating nice assignment must NOT surface ──

check("edge window: at $1.88 (tag-exact, no in-window all-nice) NO tier surfaces a nice vector", () => {
  // The all-nice completions are price-independent (sum/monotone/caps); at
  // $1.88 every one of them lands the edge OUTSIDE [target, target+0.1pp]
  // (re-derived: the F1 vector's EV 1.61921 gives 13.87% at $1.88). The
  // engine must fall through honestly: precise fallback, edge in window,
  // never a surfaced out-of-window nice vector.
  const auto = autoRetuneTargets(LP_BASE, cfg, 0.05, 46.3);
  const assignments = enumerateLpAllNice(5000);
  for (const a of assignments) {
    const edge = 1 - a.ev / 1.88;
    assert(
      edge < auto.targetEdge - 1e-9 || edge > auto.targetEdge + 0.001 + 1e-9,
      `precondition drifted: assignment [${a.u.join(",")}] lands in-window at $1.88`,
    );
  }
  const r = shapeWeights({
    cards: LP_VALUES.map((v) => ({ value: v })),
    price: 1.88,
    targetEdge: auto.targetEdge,
    targetWinRate: 0.05,
    maxWinCap: auto.maxWinCap,
    nearMissMin: 0,
    winRateTol: TAGGED_WINRATE_TOLERANCE,
    currentWeights: LP_LIVE_W,
    winRateIsHard: true,
  });
  const ok = assertSuccess(r, "$1.88 solve");
  assert(ok.snapped === false, `snapped=${ok.snapped} — every tier must refuse at $1.88`);
  assert(ok.allNice === undefined, "allNice must be unset on the precise fallback");
  assert(
    ok.edge >= auto.targetEdge - 1e-9 &&
      ok.edge <= auto.targetEdge + 0.001 + ONE_SIDED_EDGE_EXCESS_TOL + 1e-9,
    `precise fallback edge ${(ok.edge * 100).toFixed(4)}% out of the accepted band`,
  );
});

// ── 8. Untagged golden (byte-identical before/after) ─────────────────────

check("untagged golden: anchored search byte-identical to the pre-niceness engine (a46722c4)", () => {
  // Golden derived 2026-07-03 by running this exact input against the
  // PRISTINE a46722c4 risk.ts side-by-side with the niceness build — both
  // returned $2.60 / searched 21 / snapped / [400000,150000,449900,100] /
  // edge 0.11093076923076917. Untagged flows never touch the nice tiers
  // (niceTier is structurally 0 → comparator inert).
  const s = searchBestPriceForCleanSnap({
    cards: [{ value: 0.35 }, { value: 1.8 }, { value: 4.2 }, { value: 120 }],
    basePrice: 2.5,
    targetEdge: 0.1105,
    targetWinRate: 0.2,
    maxWinCap: 250,
    nearMissMin: 0.1,
    winRateTol: 0.02,
    currentWeights: [880000, 90000, 29900, 100],
    maxPriceChangePct: 0.6,
    upwardPriceExtensionPct: 0,
  });
  const r = assertSuccess(s.bestResult, "untagged golden");
  assert(Math.round(s.bestPrice * 100) === 260, `bestPrice $${s.bestPrice} ≠ $2.60`);
  assert(s.searched === 21, `searched=${s.searched} ≠ 21`);
  assert(s.taggedAccuracyHit === null, "untagged: taggedAccuracyHit must be null");
  assert(
    JSON.stringify(r.weights) === JSON.stringify([400000, 150000, 449900, 100]),
    `weights [${r.weights.join(",")}]`,
  );
  assert(Math.abs(r.edge - 0.11093076923076917) < 1e-12, `edge ${r.edge}`);
  assert(r.snapped === true, "snapped");
  assert(r.allNice === undefined && r.niceExemptIdx === undefined, "untagged results never set niceness fields");
});

// ── 9. Pins interplay (the §5 contract, testable now) ────────────────────

check("pins: a pinned win card survives the nice snap verbatim, exempt from accounting; unpinned wins absorb W − pinned", () => {
  // The pins harness's tagged 1% pool with the jackpot pinned at 0.02%.
  const pool = {
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
  const r = assertSuccess(
    shapeWeights({ ...pool, pinnedShares: [{ index: 0, share: 0.0002 }] }),
    "pinned tagged solve",
  );
  const total = r.weights.reduce((a, b) => a + (b > 0 ? b : 0), 0);
  const held = r.weights[0]! / total;
  assert(Math.abs(held - 0.0002) <= 1e-9, `pin drifted: ${held}`);
  assert(Math.abs(r.risk.winRate - 0.01) <= TAGGED_WINRATE_TOLERANCE + 1e-12, "tag exact with the pin inside");
  if (r.snapped === true && r.niceExemptIdx !== undefined) {
    assert(r.niceExemptIdx.includes(0), "the pinned index must be niceness-exempt");
    // Unpinned win band absorbs exactly the tag remainder.
    const winShare = (r.weights[1]! + r.weights[2]!) / total;
    assert(
      Math.abs(winShare - (0.01 - 0.0002)) <= 1e-9,
      `unpinned win share ${winShare} ≠ W − pinned`,
    );
    assert(
      r.allNice === (countOffNicePct(r.weights, r.niceExemptIdx) === 0),
      "allNice must equal the shared off-nice count",
    );
  }
});

// ── 10. Consistency + determinism ────────────────────────────────────────

check("consistency: allNice ⟺ zero non-exempt off-nice (the plan projection's own filter agrees)", () => {
  for (const [label, s] of [
    ["F1", f1 ?? runTaggedSearch(LP_VALUES, LP_LIVE_W, LP_BASE, 0.05)],
    ["F4", runTaggedSearch(SYNB_VALUES, SYNB_LIVE_W, 8.0, 0.01)],
  ] as const) {
    const r = assertSuccess(s.bestResult, label);
    assert(r.snapped === true && r.allNice !== undefined, `${label} must be a tagged snap`);
    const off = countOffNicePct(r.weights, r.niceExemptIdx);
    assert(r.allNice === (off === 0), `${label}: allNice=${r.allNice} vs off=${off}`);
    // Mirror of projectPlannedVector's tagged filter (pct > 0, off the nice
    // grid, not exempt) — must agree with the shared counter.
    const total = r.weights.reduce((a, b) => a + (b > 0 ? b : 0), 0);
    const exempt = new Set(r.niceExemptIdx ?? []);
    let projected = 0;
    for (let i = 0; i < r.weights.length; i++) {
      const pct = r.weights[i]! > 0 ? (r.weights[i]! / total) * 100 : 0;
      if (pct > 0 && !isOnNiceGridPct(pct) && !exempt.has(i)) projected += 1;
    }
    assert(projected === off, `${label}: projection ${projected} ≠ engine ${off}`);
    // Tag exactness: the win-band unit sum is EXACTLY W on the snap grid.
    const price = s.bestPrice;
    const values = label === "F1" ? LP_VALUES : SYNB_VALUES;
    const tag = label === "F1" ? 0.05 : 0.01;
    let winUnits = 0;
    for (let i = 0; i < values.length; i++) {
      if (values[i]! >= price) winUnits += r.weights[i]!;
    }
    assert(
      winUnits === Math.round(tag * total),
      `${label}: win units ${winUnits} ≠ ${Math.round(tag * total)}`,
    );
  }
});

check("determinism: F1 and F3 run twice — byte-identical outputs", () => {
  const norm = (s: SearchBestPriceResult) =>
    JSON.stringify({
      p: s.bestPrice,
      n: s.searched,
      r: "error" in s.bestResult ? s.bestResult.limit.kind : s.bestResult.weights,
    });
  assert(
    norm(runTaggedSearch(LP_VALUES, LP_LIVE_W, LP_BASE, 0.05)) ===
      norm(runTaggedSearch(LP_VALUES, LP_LIVE_W, LP_BASE, 0.05)),
    "F1 must be deterministic",
  );
  assert(norm(runSynA()) === norm(runSynA()), "F3 must be deterministic");
});

// ── Summary ──────────────────────────────────────────────────────────────
console.log(
  `\n${passes} passed, ${failures.length} failed${
    failures.length > 0 ? ` — ${failures.join(", ")}` : ""
  }`,
);
if (failures.length > 0) process.exit(1);
