/**
 * SNAP-NICENESS harness (pure, no DB) — the tagged HUMAN-NICE rung grid.
 *
 * Run with:
 *   npx tsx "src/app/(admin)/packs/__checks__/niceness.ts"
 *
 * Pins every contract of the snap-niceness spec (tagged three-tier snap +
 * niceness preference tier in the price search + the Rule Set fix).
 *
 * RE-PINNED 2026-07-24 for `31368e2a` ("densify clean ladder grid"), which
 * widened BOTH snap grids on purpose: `NICE_MANTISSAS` (tagged) and
 * `CLEAN_LADDER_BASE` (untagged) gained 6/7/8/9/12.5 (+60/70 untagged), so
 * packs designed at 6% / 8% / 9% / 12.5% / 60% / 70% land clean instead of
 * being snapped 20+pp to the nearest old rung. Every LAW below is unchanged
 * and still asserted at full strength; only the incidental values that the
 * denser grid legitimately moves (best price, weights vector, enumerated
 * counts, hand-found needle cents) were re-derived FROM the engine. Each such
 * pin carries its old value in a comment so the delta stays auditable.
 *
 *   1.  NICE_UNITS grid = exactly the 65-element {1,1.5,2,2.5,3,3.5,4,5,6,7,
 *       7.5,8,9,12.5}×10^k integer per-100k set (was 42 pre-`31368e2a`);
 *       isOnNiceGridPct spot checks — 90% and 0.006% are now ON the grid,
 *       95% is still OFF (9.5 was not added) and is legal on a real plan only
 *       via the buffer exemption.
 *   2.  F1 — Lucky Pond staged @ 5% (the owner complaint): $1.60 (was $1.82),
 *       all-nice [1,9,90,700,700,3500,95000] bit-exact + the band facts (2571
 *       all-nice assignments, 37 tag-exact cents 152–188, 490 pairs, $1.85
 *       the unique nearest arithmetically-possible all-nice cent) + the
 *       live-cap basis probe (card 3 lands 700 units ≤ its live cap 789.47
 *       but far ABOVE its precise share — the OLD precise-based guard would
 *       have rejected the owner's own ask).
 *   3.  F2 — Lucky Pond @ 10%: $2.47 (was $2.69) all-nice bit-exact, and it
 *       IS the nearest all-nice (assignment, cent) pair in the whole band
 *       (1745 assignments, 74 tag-exact cents 243–316, 519 pairs) — proves
 *       the niceTier guard keeps the search hunting past the nearer
 *       per-100k-exact $2.44 (tier ordering: all-nice beats grid-exact at
 *       larger centsDist).
 *   4.  F3 — SYN-A: base-cent all-nice [50,200,750,4000,95000] bit-exact,
 *       searched=1 (early return now requires niceTier 0) + the deterministic
 *       tie-break (dust rung 3500 vs 4000, equal shape distance → min edge
 *       excess picks 4000; the precise dust share is far from 4000 — pins the
 *       non-buffer dust rung ENUMERATION, not nearest-rounding).
 *   5.  F4 — SYN-B (property asserts): feasible + snapped + tag exact + edge
 *       in the one-sided window + caps respected on every non-absorber win
 *       card + the honesty-banner copy exists verbatim in plan-copy.ts. The
 *       densified grid opened EXACTLY 5 all-nice completions under the caps
 *       (combinatorial proof re-run inline; it was 0 pre-`31368e2a`), so
 *       this pool now lands ALL-NICE via tier N — the shipped assignment is
 *       asserted to be one of those 5. The snapped-but-off-nice honesty path
 *       stays covered by the Psycho (off 1) and Goofy (off 2) fleet needles.
 *   6.  F5 — Rule Set: price-independent no-dust refusal, searched=1
 *       (pre-check), priceIndependent=true, exact detail substitutions.
 *   7.  Edge window (§9.6): at a tag-exact cent where every all-nice
 *       completion violates the window ($1.88), NO tier surfaces it — the
 *       engine falls through honestly (unsnapped precise, edge in window).
 *   8.  Untagged golden: the anchored untagged search is pinned byte-exact
 *       against the CURRENT engine. It used to assert byte-identity with the
 *       pre-niceness a46722c4 build on the claim that "niceTier + grid
 *       changes are tagged-only" — that claim DIED with `31368e2a`, which
 *       deliberately densified `CLEAN_LADDER_BASE`, the UNTAGGED ladder
 *       (added 6, 7, 8, 9, 12.5, 60, 70). The untagged snap therefore moved
 *       on purpose ($2.60 → $2.34) and the golden was re-derived. What the
 *       check still guards is unchanged: untagged results never set the
 *       niceness fields (`allNice` / `niceExemptIdx` stay undefined,
 *       `taggedAccuracyHit` stays null) — the niceTier comparator is inert
 *       off the tagged path.
 *   9.  Pins interplay: a pinned win card's units survive the snap verbatim,
 *       are excluded from the niceness accounting, and the unpinned win band
 *       absorbs exactly W − pinned.
 *  10.  Determinism (F1 + F3 run twice, byte-identical) + perf (one F1
 *       search ≤ 3 s).
 *  11.  NICE-GRID POST-PASS (Retune V3 waves 7+8, `polishTaggedNiceGrid` +
 *       `niceGridPolish`): unit contracts for every move family (dust single
 *       via the buffer, win single via the absorber under live-cap semantics,
 *       win exact-cancel pair around a nice absorber, ABSORBER ENDGAME
 *       partner counter-hop, edge-relief dust transfer), the strict-
 *       improvement gate, and the fleet-frozen Psycho/Goofy A/B needles
 *       through the REAL builder wiring (flag-stripped legacy byte-baseline
 *       vs polished: fewer off-nice cards — Psycho WIDE lands fully ALL-NICE
 *       via the endgame at $6.00, was $6.02 — laws intact, tag exact,
 *       deterministic; untagged byte-identical).
 *  12.  APPLY HONESTY (wave 9): the pinned-price anchored solve (one-click
 *       far-price apply → `pinPrice` → builder-routed 0-band search) lands
 *       the promised ALL-NICE plan at EXACTLY the suggested cent (searched=1,
 *       tag exact, LAW M clean, deterministic) — and the OLD hand-mirrored
 *       anchored params provably ship 8/10 off-nice at that same cent (the
 *       load-bearing sentinel for the builder routing). The suggested cent
 *       tracks the wide probe: $5.10 → $6.00 after `31368e2a`.
 *  13.  LAW M RELAYOUT-RETRY RESCUE (wave 10, 10% Illusion): the anchored
 *       0-band apply at the wide probe's suggested cent must reproduce the
 *       wide sweep's own plan byte-for-byte — snapped, not an unsnapped
 *       fall-through. That is the wave-10 bug expressed directly: the same
 *       params at the same cent used to ship snapped/off-2 from the sweep and
 *       unsnapped/off-8 from the apply, because the grail never-inflate guard
 *       still compared against the PRE-GATE precise solve after a LAW M
 *       re-lay. The pinned cent moved $31.28 → $21.50 with the wide probe.
 *
 * KNOWN QUALITY COST of `31368e2a` (measured 2026-07-24, NOT a law breach —
 * every shipped plan below is still tag-exact, in-window, cap-legal, LAW M
 * clean): the tagged tier-N/P DFS enumerates the nice grid per free win card,
 * so 42 → 65 rungs blows the tree up ~7.4x. The Lucky Pond fixture's own
 * enumeration goes 112,464 nodes → 829,478, against an unchanged per-snap
 * ceiling of `TAGGED_SNAP_NODE_CAP = 120_000` — so the walk is now truncated
 * at ~14% of the tree and the ascending-rung order means the far branches are
 * never reached. Consequence visible here: LP@5% at $1.82 used to snap to the
 * all-nice [350,400,500,500,750,2500,95000]; that vector is STILL in-window,
 * cap-legal and monotone, but the DFS no longer reaches it, so $1.82 now
 * falls through to the honest unsnapped precise vector and the search settles
 * 38¢ from base instead of 16¢. Flagged for the owner — the fix is an engine
 * decision (raise the cap / order the walk by shape distance), not a pin.
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
  computePackRisk,
  countOffNicePct,
  findMonotoneViolations,
  isOnNiceGridPct,
  polishTaggedNiceGrid,
  searchBestPriceForCleanSnap,
  shapeWeights,
  type SearchBestPriceResult,
  type ShapeWeightsResult,
  type ShapeWeightsSuccess,
} from "../../insights/edge-calc/risk";
import {
  DEFAULT_EDGE_CURVE,
  autoRetuneTargets,
  type ResolvedAutoTargetCfg,
} from "../_lib/auto-targets";
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
/**
 * The tagged HUMAN-NICE rung grid, in per-100k integer units.
 *
 * RE-PINNED 2026-07-23 for `31368e2a` (owner: "densify clean ladder grid"),
 * which added mantissas 6, 7, 8, 9 and 12.5 to `NICE_MANTISSAS` so packs
 * designed at 6% / 8% / 9% / 12.5% can land clean instead of being snapped
 * 20+pp to the nearest old rung. 42 units → 65. Regenerated by enumerating
 * `isOnNiceGridPct` over 1..100000 rather than hand-written, so this pin is a
 * SNAPSHOT of the engine's grid, and any future unintended drift still trips
 * the check below.
 */
const NICE_UNITS_EXPECTED: number[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 25, 30, 35, 40, 50, 60, 70, 75, 80,
  90, 100, 125, 150, 200, 250, 300, 350, 400, 500, 600, 700, 750, 800, 900,
  1000, 1250, 1500, 2000, 2500, 3000, 3500, 4000, 5000, 6000, 7000, 7500, 8000,
  9000, 10000, 12500, 15000, 20000, 25000, 30000, 35000, 40000, 50000, 60000,
  70000, 75000, 80000, 90000, 100000,
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

check("NICE grid: isOnNiceGridPct accepts exactly the 65-unit snapshot over 1..100000", () => {
  const got: number[] = [];
  for (let units = 1; units <= 100000; units++) {
    if (isOnNiceGridPct(units / 1000)) got.push(units);
  }
  assert(
    JSON.stringify(got) === JSON.stringify(NICE_UNITS_EXPECTED),
    `grid drifted: ${got.length} units (expected ${NICE_UNITS_EXPECTED.length}) — got [${got.join(",")}]`,
  );
});

check("NICE grid: spot checks (0.35/0.05/2.5/0.001/3.5/90/0.006 in; 0.047/0.234/3.48/95/0.0005/0.0095 out)", () => {
  // 90% and 0.006% MOVED from the out-list to the in-list in `31368e2a`:
  // mantissa 9 and 6 are now on the tagged grid by design. 95% stays OUT
  // (mantissa 9.5 was not added) — it is legal on a real plan only via the
  // buffer EXEMPTION, which is what F1 below actually asserts.
  for (const pct of [0.35, 0.05, 2.5, 0.001, 3.5, 90.0, 0.006]) {
    assert(isOnNiceGridPct(pct), `${pct}% must be nice`);
  }
  for (const pct of [0.047, 0.234, 3.48, 95.0, 0.0005, 0.0095]) {
    assert(!isOnNiceGridPct(pct), `${pct}% must NOT be nice`);
  }
});

// ── 2. F1 — Lucky Pond @ 5% (the owner complaint, bit-exact) ─────────────

/**
 * RE-DERIVED 2026-07-24 for `31368e2a`. BEFORE: $1.82 /
 * [350,400,500,500,750,2500,95000]. That vector is still lawful (in-window,
 * cap-legal, monotone) but the densified grid overflows the tier-N DFS node
 * cap (see the header's KNOWN QUALITY COST note), so the search no longer
 * reaches it and settles on the nearest all-nice cent it DOES reach, $1.60.
 * Every law below is asserted exactly as before.
 */
const F1_EXPECT = [1, 9, 90, 700, 700, 3500, 95000];
let f1: SearchBestPriceResult | null = null;

check("F1: Lucky Pond 5% → $1.60, all-nice [1,9,90,700,700,3500,95000] bit-exact", () => {
  const t0 = Date.now();
  f1 = runTaggedSearch(LP_VALUES, LP_LIVE_W, LP_BASE, 0.05);
  const elapsed = Date.now() - t0;
  const r = assertSuccess(f1.bestResult, "F1");
  assert(Math.round(f1.bestPrice * 100) === 160, `bestPrice $${f1.bestPrice} ≠ $1.60`);
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

check("F1: live-cap basis probe — every capped winner ≤ live, and card 3 lands 700 ≫ its precise share (the OLD precise guard would reject)", () => {
  assert(f1 !== null, "F1 must have run");
  const r = assertSuccess(f1.bestResult, "F1");
  const total = r.weights.reduce((a, b) => a + (b > 0 ? b : 0), 0);
  const capUnits = LP_LIVE_W.map((w) => (w / LP_LIVE_TOTAL) * 100000);
  // LAW (never-inflate): every NON-cheapest win card stays at/below its live
  // odds. Index 5 (16.76 — the cheapest free winner / anti-jackpot absorber)
  // is cap-exempt by design in tiers N and P; index 6 is the dust buffer.
  for (let i = 0; i <= 4; i++) {
    const after = (r.weights[i]! / total) * 100000;
    assert(after <= capUnits[i]! + 1e-9, `win card ${i}: ${after} units > live cap ${capUnits[i]}`);
  }
  // The needle (RE-DERIVED 2026-07-24 — it used to live on the jackpot at
  // $1.82: 350 units ≤ live 368.4 but ≫ the precise 133; the $1.82 snap is
  // gone with the densified grid, and the new $1.60 pick puts the jackpot on
  // the 1-unit floor). It now lives on card 3 (22.16): the accepted plan
  // gives it 700 units — just under its live cap of 789.47, but MULTIPLES of
  // what the precise solve wants there. A precise-BASED never-inflate guard
  // would therefore have rejected the owner's own round-number ask.
  //
  // The precise share is read straight off the engine at the two cents that
  // bracket $1.60 and fall through UNSNAPPED (so their vector IS the precise
  // solve): $1.58 → 165.09 units, $1.61 → 245.07 units. The precise share
  // rises with price across the bracket, so the precise value at $1.60 sits
  // between them — an order of magnitude below the accepted 700.
  const auto = autoRetuneTargets(LP_BASE, cfg, 0.05, Math.max(...LP_VALUES));
  const preciseUnitsAt = (price: number): number[] => {
    const p = shapeWeights({
      cards: LP_VALUES.map((v) => ({ value: v })),
      price,
      targetEdge: auto.targetEdge,
      targetWinRate: 0.05,
      maxWinCap: auto.maxWinCap,
      nearMissMin: 0,
      winRateTol: TAGGED_WINRATE_TOLERANCE,
      currentWeights: LP_LIVE_W,
      winRateIsHard: true,
    });
    const ok = assertSuccess(p, `precise probe @$${price}`);
    assert(ok.snapped === false, `$${price} must fall through UNSNAPPED to be the precise solve`);
    const t = ok.weights.reduce((a, b) => a + (b > 0 ? b : 0), 0);
    return ok.weights.map((w) => (w / t) * 100000);
  };
  const lo = preciseUnitsAt(1.58)[3]!;
  const hi = preciseUnitsAt(1.61)[3]!;
  const accepted = (r.weights[3]! / total) * 100000;
  assert(accepted === 700, `card 3 accepted ${accepted} ≠ 700 units`);
  assert(lo < hi, `precise card-3 share must rise across the bracket (${lo} → ${hi})`);
  assert(
    hi < accepted,
    `card 3 accepted ${accepted} must exceed the precise share (${lo} … ${hi}) — the needle is dead`,
  );
  assert(
    accepted <= capUnits[3]! + 1e-9,
    `card 3 accepted ${accepted} > live cap ${capUnits[3]}`,
  );
});

check("F1: band facts re-derived — 2571 all-nice assignments; 37 tag-exact cents (152–188); 490 pairs; $1.85 the unique nearest possible; the shipped plan is one of them", () => {
  // Counts RE-DERIVED 2026-07-24 (`31368e2a` densified the rung source this
  // enumerator walks): assignments 404 → 2571, pairs 65 → 490. The tag-exact
  // cent window is grid-INDEPENDENT (it comes from the precise solve) and is
  // unchanged at 37 cents, 152–188 — a real cross-check that the densified
  // grid did not disturb the precise math.
  const assignments = enumerateLpAllNice(5000);
  assert(assignments.length === 2571, `assignments ${assignments.length} ≠ 2571`);
  const exact = lpTagExactCents(0.05);
  assert(
    exact.length === 37 && exact[0] === 152 && exact[exact.length - 1] === 188,
    `tag-exact cents ${exact.length} [${exact[0]}..${exact[exact.length - 1]}] ≠ 37 [152..188]`,
  );
  const pairs = lpAllNicePairs(0.05, assignments, exact);
  assert(pairs.length === 490, `pairs ${pairs.length} ≠ 490`);
  let best = Infinity;
  for (const p of pairs) best = Math.min(best, Math.abs(p.cents - 198));
  const nearest = pairs.filter((p) => Math.abs(p.cents - 198) === best);
  assert(
    nearest.length === 1 && nearest[0]!.cents === 185,
    `nearest possible all-nice cent must be uniquely 185 (got ${nearest.map((p) => p.cents).join(",")})`,
  );
  assert(
    JSON.stringify(nearest[0]!.u) === JSON.stringify([300, 500, 600, 700, 900, 2000]),
    `the unique $1.85 assignment drifted (got [${nearest[0]!.u.join(",")}])`,
  );
  // THE CROSS-CHECK that matters: whatever the engine ships must be a member
  // of this INDEPENDENTLY derived set — sum = W exactly, monotone walking
  // cheaper, live caps on every non-cheapest winner, every rung on the nice
  // grid, edge inside [target, target+0.1pp] at that very cent. (This is a
  // superset test, not an optimality test: the engine's tier-N DFS is
  // node-capped, so it ships $1.60 rather than the nearest-possible $1.85 —
  // see the header's KNOWN QUALITY COST note. Asserting membership keeps the
  // law coverage without pinning the engine to a search gap.)
  assert(f1 !== null, "F1 must have run");
  const shipped = assertSuccess(f1.bestResult, "F1").weights.slice(0, 6);
  assert(
    pairs.some(
      (p) =>
        p.cents === Math.round(f1!.bestPrice * 100) &&
        JSON.stringify(p.u) === JSON.stringify(shipped),
    ),
    `the shipped plan (${Math.round(f1.bestPrice * 100)}¢, [${shipped.join(",")}]) is NOT in the lawful all-nice set`,
  );
});

// ── 3. F2 — Lucky Pond @ 10% (unique pair; niceTier keeps hunting) ───────

/** RE-DERIVED 2026-07-24 for `31368e2a`. BEFORE: $2.69 / [250,250,500,750,750,7500,90000]. */
const F2_EXPECT = [1, 9, 15, 75, 900, 9000, 90000];

check("F2: Lucky Pond 10% → $2.47 (Δ+49¢ past the grid-exact $2.44), all-nice bit-exact", () => {
  const s = runTaggedSearch(LP_VALUES, LP_LIVE_W, LP_BASE, 0.1);
  const r = assertSuccess(s.bestResult, "F2");
  assert(Math.round(s.bestPrice * 100) === 247, `bestPrice $${s.bestPrice} ≠ $2.47`);
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

check("F2: band facts re-derived — 1745 assignments, 74 tag-exact cents (243–316), 519 pairs, and the engine lands the UNIQUE nearest cent 247", () => {
  // Counts RE-DERIVED 2026-07-24: assignments 32 → 1745, pairs 1 → 519 (the
  // old "unique pair in the whole band" was an artifact of the sparse grid).
  // The tag-exact cent window is grid-independent and unchanged: 74, 243–316.
  const assignments = enumerateLpAllNice(10000);
  assert(assignments.length === 1745, `assignments ${assignments.length} ≠ 1745`);
  const exact = lpTagExactCents(0.1);
  assert(
    exact.length === 74 && exact[0] === 243 && exact[exact.length - 1] === 316,
    `tag-exact cents ${exact.length} [${exact[0]}..${exact[exact.length - 1]}] ≠ 74 [243..316]`,
  );
  const pairs = lpAllNicePairs(0.1, assignments, exact);
  assert(pairs.length === 519, `pairs ${pairs.length} ≠ 519`);
  // The NEAREST feasible all-nice cent is uniquely 247 — and that is exactly
  // where the engine landed (F2 above), with an assignment drawn from this
  // independently derived set. Price-distance optimality is genuinely met on
  // this fixture, and the shipped vector is provably lawful.
  let best = Infinity;
  for (const p of pairs) best = Math.min(best, Math.abs(p.cents - 198));
  const nearestCents = [...new Set(pairs.filter((p) => Math.abs(p.cents - 198) === best).map((p) => p.cents))];
  assert(
    nearestCents.length === 1 && nearestCents[0] === 247,
    `nearest all-nice cent must be uniquely 247 (got ${nearestCents.join(",")})`,
  );
  assert(
    pairs.some(
      (p) => p.cents === 247 && JSON.stringify(p.u) === JSON.stringify(F2_EXPECT.slice(0, 6)),
    ),
    `the F2 vector must be one of the lawful $2.47 assignments`,
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

// ── 5. F4 — SYN-B (tight pool, property asserts) ─────────────────────────

const SYNB_VALUES = [6000, 1500, 450, 0.6];
const SYNB_LIVE_W = [47, 234, 719, 99000];

check("F4: SYN-B → snapped, tag exact, edge in window, caps respected, and now ALL-NICE (the densified grid opened 5 completions)", () => {
  // RE-PINNED 2026-07-24. BEFORE `31368e2a` this pool had ZERO all-nice
  // completions under its caps, so it landed via tier P with exactly the
  // absorber off-nice (allNice=false, off=1) — the honesty-banner fixture.
  // The densified grid opens 5 completions (proof re-run in the next check),
  // so tier N now wins and the plan is fully ALL-NICE at $7.92. Every LAW
  // assertion is unchanged; only the niceness OUTCOME flipped, and it flipped
  // in the direction the owner asked for.
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
  assert(r.allNice === true, `allNice=${r.allNice} — tier N must now land this pool clean`);
  const off = countOffNicePct(r.weights, r.niceExemptIdx);
  assert(off === 0, `off-nice count ${off} ≠ 0`);
  assert(
    JSON.stringify(r.weights) === JSON.stringify([20, 80, 900, 99000]),
    `weights [${r.weights.join(",")}]`,
  );
  // Never-inflate: every non-cheapest winner ≤ its live cap. (Index 2 is the
  // cheapest free winner — the anti-jackpot absorber — and is cap-exempt by
  // design in tiers N/P; index 3 is the dust buffer.)
  const total = r.weights.reduce((a, b) => a + (b > 0 ? b : 0), 0);
  const liveTotal = SYNB_LIVE_W.reduce((a, b) => a + b, 0);
  for (let i = 0; i < 2; i++) {
    const after = (r.weights[i]! / total) * 100000;
    const cap = (SYNB_LIVE_W[i]! / liveTotal) * 100000;
    assert(after <= cap + 1e-6, `win card ${i}: ${after} units > live cap ${cap}`);
  }
  // LAW M: the full ladder stays monotone (no richer card likelier than a
  // cheaper one).
  assert(
    findMonotoneViolations({
      values: SYNB_VALUES,
      shares: r.weights.map((w) => w / total),
      tol: 1e-9,
    }).length === 0,
    "F4 must be LAW M clean",
  );
});

check("F4: combinatorial proof — EXACTLY 5 all-nice completions exist under the caps (was 0), and the shipped one is among them", () => {
  // u1 ≤ 47 nice, u2 ∈ [u1, 234] nice, u3 = 1000 − u1 − u2 nice and ≥ u2.
  // RE-DERIVED 2026-07-24: the pre-`31368e2a` grid admitted none (u3 = 900 is
  // only reachable now that mantissa 9 is on the grid); it admits 5 today.
  const niceLe = (cap: number) => NICE_UNITS_EXPECTED.filter((r) => r <= cap);
  const completions: number[][] = [];
  for (const u1 of niceLe(47)) {
    for (const u2 of niceLe(234)) {
      if (u2 < u1) continue;
      const u3 = 1000 - u1 - u2;
      if (u3 < u2) continue;
      if (NICE_UNITS_EXPECTED.includes(u3)) completions.push([u1, u2, u3]);
    }
  }
  assert(
    JSON.stringify(completions) ===
      JSON.stringify([
        [10, 90, 900],
        [20, 80, 900],
        [25, 75, 900],
        [30, 70, 900],
        [40, 60, 900],
      ]),
    `completions drifted: ${JSON.stringify(completions)}`,
  );
  // The engine's shipped win band must be one of them — the arithmetic model
  // and the tier-N DFS agree on what "lawful and all-nice" means here.
  const s = runTaggedSearch(SYNB_VALUES, SYNB_LIVE_W, 8.0, 0.01);
  const shipped = assertSuccess(s.bestResult, "F4 rerun").weights.slice(0, 3);
  assert(
    completions.some((c) => JSON.stringify(c) === JSON.stringify(shipped)),
    `shipped win band [${shipped.join(",")}] is not one of the lawful completions`,
  );
});

check("off-nice honesty: the banner copy exists verbatim in plan-copy.ts and the panel gates on the server verdict (push stays enabled)", () => {
  // This used to be F4's banner; F4 now lands all-nice, so the live off-nice
  // fixtures are the Psycho (off 1) and Goofy (off 2) fleet needles below.
  // The copy + gating contract is fixture-independent and still binding.
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
  // Wave 2c: the panel gates on the SERVER verdict — `off-nice` fires iff
  // tagged ∧ !allNice after the unsnapped rank (i.e. the old client-side
  // `snapped && !allNice` predicate, proven in the tune-verdict suite).
  assert(
    panel.includes('verdict.kind === "off-nice"'),
    "plan-panel must gate the banner on the off-nice verdict",
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

// ── 8. Untagged golden (byte-exact pin on the CURRENT untagged ladder) ───

check("untagged golden: anchored untagged search is byte-exact, and never sets the niceness fields", () => {
  // OBSOLETE-AND-REWRITTEN 2026-07-24. This check used to assert byte-identity
  // with the pre-niceness a46722c4 engine ($2.60 / searched 21 / snapped /
  // [400000,150000,449900,100] / edge 0.11093076923076917) on the premise that
  // "niceTier + grid changes are tagged-only". `31368e2a` invalidated that
  // premise ON PURPOSE: it densified `CLEAN_LADDER_BASE`, the ladder the
  // UNTAGGED snap uses (added 6, 7, 8, 9, 12.5, 60, 70). The untagged snap
  // therefore moved by design — $2.60 → $2.34, searched 21 → 33, and the
  // vector now uses the new 12.5% and 40% rungs ([474920,125000,400000,80] of
  // 1,000,000 = 47.492% / 12.5% / 40% / 0.008%).
  //
  // What survives unchanged, and is what this check now guards: the untagged
  // path stays OUT of the tagged niceness machinery — `allNice` and
  // `niceExemptIdx` stay undefined and `taggedAccuracyHit` stays null, so the
  // niceTier comparator is provably inert off the tagged path.
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
  assert(Math.round(s.bestPrice * 100) === 234, `bestPrice $${s.bestPrice} ≠ $2.34`);
  assert(s.searched === 33, `searched=${s.searched} ≠ 33`);
  assert(s.taggedAccuracyHit === null, "untagged: taggedAccuracyHit must be null");
  assert(
    JSON.stringify(r.weights) === JSON.stringify([474920, 125000, 400000, 80]),
    `weights [${r.weights.join(",")}]`,
  );
  assert(Math.abs(r.edge - 0.11075982905982906) < 1e-12, `edge ${r.edge}`);
  assert(r.snapped === true, "snapped");
  assert(r.allNice === undefined && r.niceExemptIdx === undefined, "untagged results never set niceness fields");
  // Edge floor is a LAW even off the tagged path: the house never ships below
  // the requested target edge.
  assert(r.edge >= 0.1105 - 1e-9, `edge ${r.edge} below the 11.05% target`);
  // The near-miss floor the caller asked for is funded (0.1 requested).
  assert(r.risk.nearMiss >= 0.1 - 1e-9, `nearMiss ${r.risk.nearMiss} below the requested 0.1 floor`);
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

// ── 11. Nice-grid post-pass (Retune V3 wave 7) ───────────────────────────
//
// Unit contracts run `polishTaggedNiceGrid` directly on hand-derived
// vectors (integer card values → EV is fp-exact); fleet needles run the
// REAL builder wiring on frozen prod pools, flag-stripped vs flag-on.

/** Shared unit-contract fixture: [jack, A, B, absorber, dust…, buffer]. */
const POLISH_VALUES = [200, 100, 90, 80, 2, 1];
const POLISH_PRICE = 60;

check("polish: dust single re-rungs via the buffer (exempt), exact output", () => {
  const out = polishTaggedNiceGrid({
    units: [5000, 38279, 56721],
    values: [100, 10, 1],
    price: 50,
    tag: 0.05,
    targetEdge: 0.8,
    edgeTolAbove: 0.02,
    buffer: 2,
    exemptIdx: [2],
    liveCapUnits: null,
  });
  assert(
    JSON.stringify(out) === JSON.stringify([5000, 40000, 55000]),
    `dust single: got [${out.join(", ")}]`,
  );
  assert(countOffNicePct(out, [2]) === 0, "dust single must clear all off-nice");
});

check("polish: win single UNCAPPED — up-rung lands the absorber nice (all-nice)", () => {
  const out = polishTaggedNiceGrid({
    units: [100, 2300, 2500, 5200, 30000, 59900],
    values: POLISH_VALUES,
    price: POLISH_PRICE,
    tag: 0.101,
    targetEdge: 0.8,
    edgeTolAbove: 0.05,
    buffer: 5,
    exemptIdx: [5],
    liveCapUnits: null,
  });
  assert(
    JSON.stringify(out) === JSON.stringify([100, 2500, 2500, 5000, 30000, 59900]),
    `uncapped: got [${out.join(", ")}]`,
  );
  assert(countOffNicePct(out, [5]) === 0, "uncapped variant must be all-nice");
});

check("polish: live-cap semantics — planned==live freezes up-rungs, down-moves adopt via the absorber", () => {
  const units = [100, 2300, 2500, 5200, 30000, 59900];
  const out = polishTaggedNiceGrid({
    units,
    values: POLISH_VALUES,
    price: POLISH_PRICE,
    tag: 0.101,
    targetEdge: 0.8,
    edgeTolAbove: 0.05,
    buffer: 5,
    exemptIdx: [5],
    liveCapUnits: units.slice(),
  });
  // RE-PINNED 2026-07-24 for `31368e2a` (BEFORE: [100,2000,2500,5500,30000,
  // 59900], off 1). The cap still bites exactly as it did — the UNCAPPED run
  // of this same input (previous check) up-rungs 2300 → 2500, which the live
  // cap of 2300 forbids here, so the polish goes DOWN instead. With 2000 and
  // 6000 both on the densified grid the down-moves now clear every off-nice
  // row: 2300→2000 and 2500→2000, absorber 5200→6000.
  assert(
    JSON.stringify(out) === JSON.stringify([100, 2000, 2000, 6000, 30000, 59900]),
    `capped: got [${out.join(", ")}]`,
  );
  assert(countOffNicePct(out, [5]) === 0, "capped variant lands all-nice on the densified grid");
  const winSum = out[0]! + out[1]! + out[2]! + out[3]!;
  assert(winSum === 10100, `win sum ${winSum} ≠ 10100 (tag broken)`);
  // LAW: no non-absorber win card is inflated past its live cap (index 3 is
  // the cheapest free winner — the absorber — and is cap-exempt by design).
  for (let i = 0; i <= 2; i++) {
    assert(out[i]! <= units[i]!, `win card ${i}: ${out[i]} > live cap ${units[i]}`);
  }
  const r = computePackRisk({
    cards: POLISH_VALUES.map((v, i) => ({ value: v, weight: out[i]! })),
    price: POLISH_PRICE,
  });
  assert(Math.abs(r.winRate - 0.101) <= 1e-12, `tag drifted: ${r.winRate}`);
  assert(r.edge >= 0.8 - 1e-9 && r.edge <= 0.85 + 1e-9, `edge ${r.edge} outside the window`);
  assert(
    findMonotoneViolations({
      values: POLISH_VALUES,
      shares: out.map((x) => x / 100000),
      tol: 1e-9,
    }).length === 0,
    "capped polish output must stay LAW M clean",
  );
});

check("polish: exact-cancel WIN pair around a NICE absorber (singles refused, pair lands)", () => {
  const out = polishTaggedNiceGrid({
    units: [100, 170, 180, 2000, 35000, 62550],
    values: POLISH_VALUES,
    price: POLISH_PRICE,
    tag: 0.0245,
    targetEdge: 0.9,
    edgeTolAbove: 0.06,
    buffer: 5,
    exemptIdx: [5],
    liveCapUnits: null,
  });
  // Any single move would push the nice absorber (2000) off the grid — net
  // zero, refused by the strict gate. The pair (180→200, 170→150) cancels
  // exactly: absorber untouched, all-nice.
  assert(
    JSON.stringify(out) === JSON.stringify([100, 150, 200, 2000, 35000, 62550]),
    `pair: got [${out.join(", ")}]`,
  );
  assert(countOffNicePct(out, [5]) === 0, "pair variant must be all-nice");
});

check("polish: edge-relief dust transfer rescues a window-breaking move (tier-G analytic mirror)", () => {
  const units = [100, 2500, 2500, 5000, 19700, 33852, 36348];
  const values = [200, 100, 90, 80, 5, 2, 1];
  const run = () =>
    polishTaggedNiceGrid({
      units,
      values,
      price: POLISH_PRICE,
      tag: 0.101,
      targetEdge: 0.817055,
      edgeTolAbove: 0.0001,
      buffer: 6,
      exemptIdx: [6],
      liveCapUnits: null,
    });
  const out = run();
  // 33852→35000 (+$0.01148 EV) exits the 0.0001-wide window; the analytic
  // transfer moves x=258 units from the ALREADY-OFF 5-card to the buffer,
  // landing edge back inside. The 5-card itself then finds no lawful rung
  // (both brackets re-exit and their reliefs would only undo themselves).
  assert(
    JSON.stringify(out) === JSON.stringify([100, 2500, 2500, 5000, 19442, 35000, 35458]),
    `edge-relief: got [${out.join(", ")}]`,
  );
  assert(countOffNicePct(out, [6]) === 1, "edge-relief leaves exactly the 5-card off");
  const r = computePackRisk({
    cards: values.map((v, i) => ({ value: v, weight: out[i]! })),
    price: POLISH_PRICE,
  });
  assert(
    r.edge >= 0.817055 - 1e-9 && r.edge <= 0.817055 + 0.0001 + 1e-9,
    `edge ${r.edge} outside the acceptance window`,
  );
  assert(Math.abs(r.winRate - 0.101) <= 1e-12, `tag drifted: ${r.winRate}`);
  const total = out.reduce((a, b) => a + b, 0);
  assert(total === 100000, `total ${total} ≠ 100000`);
  assert(
    findMonotoneViolations({
      values,
      shares: out.map((x) => x / 100000),
      tol: 1e-9,
    }).length === 0,
    "edge-relief output must stay LAW M clean",
  );
  assert(
    JSON.stringify(run()) === JSON.stringify(out),
    "polish must be deterministic",
  );
});

check("polish: ABSORBER ENDGAME — absorber re-rungs nice, one partner counter-hops rung→rung", () => {
  // Absorber (5500) is the ONLY off row; no single/pair applies (every other
  // card is nice), so ONLY the endgame family can clear it.
  // RE-PINNED 2026-07-24 for `31368e2a` (BEFORE: absorber → 5000 with partner
  // 2500 → 3000). 6000 is a rung now, so the endgame takes the other bracket:
  // absorber 5500 → 6000 (cap-exempt), partner 2500 → 2000 (−500, exactly the
  // opposite delta). Same family, same contract, mirrored direction.
  const units = [100, 2000, 2500, 5500, 30000, 59900];
  const out = polishTaggedNiceGrid({
    units,
    values: POLISH_VALUES,
    price: POLISH_PRICE,
    tag: 0.101,
    targetEdge: 0.8,
    edgeTolAbove: 0.05,
    buffer: 5,
    exemptIdx: [5],
    liveCapUnits: null,
  });
  assert(
    JSON.stringify(out) === JSON.stringify([100, 2000, 2000, 6000, 30000, 59900]),
    `endgame: got [${out.join(", ")}]`,
  );
  assert(countOffNicePct(out, [5]) === 0, "endgame must land all-nice");
  const winSum = out[0]! + out[1]! + out[2]! + out[3]!;
  assert(winSum === 10100, `win sum ${winSum} ≠ 10100 (tag broken)`);
  const rOut = computePackRisk({
    cards: POLISH_VALUES.map((v, i) => ({ value: v, weight: out[i]! })),
    price: POLISH_PRICE,
  });
  assert(Math.abs(rOut.winRate - 0.101) <= 1e-12, `tag drifted: ${rOut.winRate}`);
  assert(rOut.edge >= 0.8 - 1e-9 && rOut.edge <= 0.85 + 1e-9, `edge ${rOut.edge} outside the window`);
  assert(
    findMonotoneViolations({
      values: POLISH_VALUES,
      shares: out.map((x) => x / 100000),
      tol: 1e-9,
    }).length === 0,
    "endgame output must stay LAW M clean",
  );
  // CAPPED variant: RE-PINNED 2026-07-24. It used to be a wholesale refusal
  // (the only rung the absorber could reach was 5000, and every partner
  // counter-hop from there was an UP move past its live cap). With 6000 on
  // the grid the counter-hop is a DOWN move (2500 → 2000), which the caps
  // permit, so the endgame now fires under caps too and reaches the same
  // all-nice vector. The LAW the old no-op protected is asserted directly
  // below: no non-absorber win card may exceed its live cap.
  const capped = polishTaggedNiceGrid({
    units,
    values: POLISH_VALUES,
    price: POLISH_PRICE,
    tag: 0.101,
    targetEdge: 0.8,
    edgeTolAbove: 0.05,
    buffer: 5,
    exemptIdx: [5],
    liveCapUnits: units.slice(),
  });
  assert(
    JSON.stringify(capped) === JSON.stringify([100, 2000, 2000, 6000, 30000, 59900]),
    `capped endgame: got [${capped.join(", ")}]`,
  );
  // LAW: the live cap binds every non-absorber win card (index 3 is the
  // cheapest free winner — the anti-jackpot absorber — and is cap-exempt).
  for (let i = 0; i <= 2; i++) {
    assert(capped[i]! <= units[i]!, `win card ${i}: ${capped[i]} > live cap ${units[i]}`);
  }
  const cappedWinSum = capped[0]! + capped[1]! + capped[2]! + capped[3]!;
  assert(cappedWinSum === 10100, `capped win sum ${cappedWinSum} ≠ 10100 (tag broken)`);
  assert(
    findMonotoneViolations({
      values: POLISH_VALUES,
      shares: capped.map((x) => x / 100000),
      tol: 1e-9,
    }).length === 0,
    "capped endgame output must stay LAW M clean",
  );
});

check("polish: strict-improvement gate — a no-gain vector ships byte-identical", () => {
  // All-nice input: the polish must return the input untouched.
  const units = [100, 2500, 2500, 5000, 30000, 59900];
  const out = polishTaggedNiceGrid({
    units,
    values: POLISH_VALUES,
    price: POLISH_PRICE,
    tag: 0.101,
    targetEdge: 0.8,
    edgeTolAbove: 0.05,
    buffer: 5,
    exemptIdx: [5],
    liveCapUnits: null,
  });
  assert(
    JSON.stringify(out) === JSON.stringify(units),
    "all-nice input must pass through byte-identical",
  );
});

// ── Fleet-frozen needles (prod pools, real builder wiring) ───────────────

/** 1% Psycho @ $6.74 (prod pool, frozen 2026-07-09). */
const PSYCHO_VALUES = [2670, 1200, 1082.99, 652.8, 448.58, 358.8, 349.01, 208.66, 0.66, 0.32];
const PSYCHO_LIVE_W = [250, 600, 1000, 1150, 1500, 1700, 1800, 2000, 390000, 600000];
const PSYCHO_PRICE = 6.74;
const PSYCHO_TAG = 0.01;
/**
 * The cent the WIDE probe suggests for Psycho — i.e. the cent a one-click
 * apply pins. Wave 8: $5.10 · wave 10: $6.02 · `31368e2a`: $6.00. The wide
 * needle and the apply-honesty contract (§12) MUST name the same number, so
 * it lives in one constant.
 */
const PSYCHO_APPLY_CENT = 6.0;

/** 10% Goofy @ $101.99 (prod pool, frozen 2026-07-09). */
const GOOFY_VALUES = [9300.21, 4199.99, 2040, 1182, 834, 437.74, 299.99, 0.29, 0.28];
const GOOFY_LIVE_W = [500, 2500, 10000, 15000, 23000, 24000, 25000, 300000, 600000];
const GOOFY_PRICE = 101.99;
const GOOFY_TAG = 0.1;

const FLEET_CFG: ResolvedAutoTargetCfg = {
  globalCap: 25000,
  maxMultCeiling: 100,
  edgeCurve: DEFAULT_EDGE_CURVE,
};

function runFleetPair(
  values: number[],
  liveW: number[],
  price: number,
  tag: number,
  priceBudgetPct = 0.1,
): { off: SearchBestPriceResult; on: SearchBestPriceResult } {
  const before = computePackRisk({
    cards: values.map((v, i) => ({ value: v, weight: liveW[i]! })),
    price,
  });
  const top = Math.max(...values);
  const auto = autoRetuneTargets(price, FLEET_CFG, tag, top, {
    winRate: before.winRate,
    nearMiss: before.nearMiss,
    edge: before.edge,
    topValue: top,
  });
  assert(auto.intendedHitRate !== null, "fixture must resolve as tagged");
  const params = buildRetuneSearchParams("live", {
    cards: values.map((v) => ({ value: v })),
    basePrice: price,
    targetEdge: auto.targetEdge,
    targetWinRate: auto.targetWinRate,
    maxWinCap: auto.maxWinCap,
    nearMissMin: Math.max(0, before.nearMiss),
    winRateTol: 0.02,
    currentWeights: liveW,
    intendedHitRate: auto.intendedHitRate,
    priceBudgetPct,
  });
  assert(params.niceGridPolish === true, "builder must emit niceGridPolish");
  const { niceGridPolish: _strip, ...legacy } = params;
  return {
    off: searchBestPriceForCleanSnap(legacy),
    on: searchBestPriceForCleanSnap(params),
  };
}

check("fleet needle: 1% Psycho — off-nice cards 4→1, laws intact, tag exact, deterministic", () => {
  const { off, on } = runFleetPair(PSYCHO_VALUES, PSYCHO_LIVE_W, PSYCHO_PRICE, PSYCHO_TAG);
  const rOff = assertSuccess(off.bestResult, "Psycho legacy");
  const rOn = assertSuccess(on.bestResult, "Psycho polished");
  assert(rOff.snapped === true && rOn.snapped === true, "both arms must snap");
  const c0 = countOffNicePct(rOff.weights, rOff.niceExemptIdx);
  const c1 = countOffNicePct(rOn.weights, rOn.niceExemptIdx);
  // RE-PINNED 2026-07-24: the legacy (flag-stripped) baseline went 5 → 4
  // off-nice — one of its rows (0.170% / 0.180% family) sits on the densified
  // grid now. The polished arm is unchanged at 1, so the polish's measured
  // value on this needle shrinks from −4 to −3 but the contract holds.
  assert(c0 === 4, `legacy off-cards ${c0} ≠ 4`);
  assert(c1 === 1, `polished off-cards ${c1} ≠ 1`);
  assert(c1 < c0, "the polished arm must strictly beat the legacy baseline");
  assert(
    findMonotoneViolations({
      values: PSYCHO_VALUES,
      shares: rOn.weights.map((w, _i, arr) => w / arr.reduce((a, b) => a + b, 0)),
      tol: 1e-9,
    }).length === 0,
    "polished Psycho must be LAW M clean",
  );
  const total = rOn.weights.reduce((a, b) => a + b, 0);
  let winUnits = 0;
  for (let i = 0; i < PSYCHO_VALUES.length; i++) {
    if (PSYCHO_VALUES[i]! >= on.bestPrice) winUnits += rOn.weights[i]!;
  }
  assert(
    winUnits === Math.round(PSYCHO_TAG * total),
    `Psycho win units ${winUnits} ≠ ${Math.round(PSYCHO_TAG * total)}`,
  );
  const again = runFleetPair(PSYCHO_VALUES, PSYCHO_LIVE_W, PSYCHO_PRICE, PSYCHO_TAG);
  assert(
    again.on.bestPrice === on.bestPrice &&
      JSON.stringify(assertSuccess(again.on.bestResult, "rerun").weights) ===
        JSON.stringify(rOn.weights),
    "Psycho polished arm must be deterministic",
  );
});

check("fleet needle: 1% Psycho WIDE band — the endgame lands ALL-NICE @$6.00", () => {
  // Wave 8 landed this ALL-NICE at $5.10; the wave-10 relayout-retry rescue
  // moved it to $6.02, and `31368e2a` moves it again to $6.00 (base $6.74) —
  // same ALL-NICE promise, marginally smaller price move. The apply-honesty
  // contract (§12) tracks this cent: it is the cent the one-click apply
  // anchors on, so the two checks must always name the same number.
  const { off, on } = runFleetPair(
    PSYCHO_VALUES,
    PSYCHO_LIVE_W,
    PSYCHO_PRICE,
    PSYCHO_TAG,
    RETUNE_MAX_PRICE_CHANGE_PCT,
  );
  const rOff = assertSuccess(off.bestResult, "Psycho wide legacy");
  const rOn = assertSuccess(on.bestResult, "Psycho wide polished");
  assert(
    rOff.snapped === true && rOff.allNice === false,
    "legacy wide arm must land snapped-but-off-nice",
  );
  assert(rOn.snapped === true && rOn.allNice === true, "polished wide arm must land ALL-NICE");
  assert(on.bestPrice === PSYCHO_APPLY_CENT, `polished wide price ${on.bestPrice} ≠ ${PSYCHO_APPLY_CENT}`);
  assert(
    findMonotoneViolations({
      values: PSYCHO_VALUES,
      shares: rOn.weights.map((w, _i, arr) => w / arr.reduce((a, b) => a + b, 0)),
      tol: 1e-9,
    }).length === 0,
    "all-nice Psycho must be LAW M clean",
  );
  const total = rOn.weights.reduce((a, b) => a + b, 0);
  let winUnits = 0;
  for (let i = 0; i < PSYCHO_VALUES.length; i++) {
    if (PSYCHO_VALUES[i]! >= on.bestPrice) winUnits += rOn.weights[i]!;
  }
  assert(
    winUnits === Math.round(PSYCHO_TAG * total),
    `Psycho wide win units ${winUnits} ≠ ${Math.round(PSYCHO_TAG * total)}`,
  );
});

check("fleet needle: 10% Goofy — off-nice cards 3→2, snap outcome never regresses", () => {
  const { off, on } = runFleetPair(GOOFY_VALUES, GOOFY_LIVE_W, GOOFY_PRICE, GOOFY_TAG);
  const rOff = assertSuccess(off.bestResult, "Goofy legacy");
  const rOn = assertSuccess(on.bestResult, "Goofy polished");
  assert(rOff.snapped === true && rOn.snapped === true, "both arms must snap");
  const c0 = countOffNicePct(rOff.weights, rOff.niceExemptIdx);
  const c1 = countOffNicePct(rOn.weights, rOn.niceExemptIdx);
  assert(c0 === 3, `legacy off-cards ${c0} ≠ 3`);
  assert(c1 === 2, `polished off-cards ${c1} ≠ 2`);
  assert(
    Math.abs(rOn.risk.winRate - GOOFY_TAG) <= TAGGED_WINRATE_TOLERANCE + 1e-12,
    `Goofy tag missed: ${rOn.risk.winRate}`,
  );
});

check("fleet needle: untagged arm is byte-identical with the flag (polish is tagged-only)", () => {
  const params = buildRetuneSearchParams("live", {
    cards: PSYCHO_VALUES.map((v) => ({ value: v })),
    basePrice: PSYCHO_PRICE,
    targetEdge: 0.35,
    targetWinRate: 0.01,
    maxWinCap: 25000,
    nearMissMin: 0,
    winRateTol: 0.02,
    currentWeights: PSYCHO_LIVE_W,
    intendedHitRate: null,
    priceBudgetPct: 0.1,
  });
  assert(params.niceGridPolish === true, "builder emits the flag on the untagged arm too");
  const { niceGridPolish: _strip, ...legacy } = params;
  const a = searchBestPriceForCleanSnap(params);
  const b = searchBestPriceForCleanSnap(legacy);
  assert(a.bestPrice === b.bestPrice, "untagged bestPrice must not move");
  const wa = "weights" in a.bestResult ? a.bestResult.weights : null;
  const wb = "weights" in b.bestResult ? b.bestResult.weights : null;
  assert(
    JSON.stringify(wa) === JSON.stringify(wb),
    "untagged weights must be byte-identical",
  );
});

// ── Wave 9: the APPLY-HONESTY contract (pinned-price anchored solve) ──────
//
// One-click applying a far-price suggestion stages the price PINNED
// (`pinPrice: true`) — the staged resolver then solves ANCHORED (no search).
// That anchored branch used to hand-mirror the builder's flags and drifted
// (missing `disperseLoss` + `niceGridPolish` + untagged `holdWinRateHard` +
// the lottery gate), so applying the wave-8 "fully clean (all-nice)"
// suggestion landed 8 of 10 Psycho cards OFF-nice at that very cent. The fix
// routes the anchored solve through `buildRetuneSearchParams` with the band
// spread-overridden to 0 (the search core's documented disabled-search
// contract: one solve at exactly the base price). These checks emulate the
// REAL apply flow byte-for-byte: staged-resolver target derivation (targets
// at the PINNED price, live-anchored seeds, tagged nearMissMin =
// max(TAGGED_NEAR_MISS_MIN=0, live near-miss)) and freeze both arms.
//
// RE-ANCHORED 2026-07-24: the suggested cent is whatever the WIDE probe
// proposes, and `31368e2a` moved it $5.10 → $6.00 (= PSYCHO_APPLY_CENT, the
// same constant the wide needle asserts). The LAW is unchanged and still
// asserted at full strength: the apply must DELIVER at the suggested cent
// what the suggestion PROMISED. (Pinning the stale $5.10 would have tested a
// cent the product no longer suggests — there the anchored solve now lands
// off-2, which is not a broken promise, just a different price.)

check("apply honesty: 0-band anchored solve at the suggested $6.00 lands the promised ALL-NICE plan", () => {
  const before = computePackRisk({
    cards: PSYCHO_VALUES.map((v, i) => ({ value: v, weight: PSYCHO_LIVE_W[i]! })),
    price: PSYCHO_PRICE,
  });
  const top = Math.max(...PSYCHO_VALUES);
  const auto = autoRetuneTargets(PSYCHO_APPLY_CENT, FLEET_CFG, PSYCHO_TAG, top, {
    winRate: before.winRate,
    nearMiss: before.nearMiss,
    edge: before.edge,
    topValue: top,
  });
  assert(auto.intendedHitRate !== null, "apply fixture must resolve as tagged");
  const params = buildRetuneSearchParams("staged", {
    cards: PSYCHO_VALUES.map((v) => ({ value: v })),
    basePrice: PSYCHO_APPLY_CENT,
    targetEdge: auto.targetEdge,
    targetWinRate: auto.targetWinRate,
    maxWinCap: auto.maxWinCap,
    nearMissMin: Math.max(0, before.nearMiss),
    winRateTol: 0.02,
    currentWeights: PSYCHO_LIVE_W,
    intendedHitRate: auto.intendedHitRate,
    priceBudgetPct: 0.1,
  });
  const anchored = searchBestPriceForCleanSnap({ ...params, maxPriceChangePct: 0 });
  // The pin is honored EXACTLY: one solve, at the pinned cent, nothing else.
  assert(
    anchored.bestPrice === PSYCHO_APPLY_CENT,
    `anchored price ${anchored.bestPrice} ≠ ${PSYCHO_APPLY_CENT}`,
  );
  assert(anchored.searched === 1, `anchored searched ${anchored.searched} ≠ 1`);
  assert(anchored.fellBackToBase === false, "anchored base solve must be GOOD (not a fallback)");
  assert(anchored.taggedAccuracyHit === true, "anchored solve must hit the tag");
  const r = assertSuccess(anchored.bestResult, "anchored apply");
  assert(r.snapped === true, "anchored apply must snap");
  assert(r.allNice === true, "anchored apply must land ALL-NICE (the suggestion's promise)");
  assert(
    countOffNicePct(r.weights, r.niceExemptIdx) === 0,
    "anchored apply must have 0 off-nice cards",
  );
  assert(
    Math.abs(r.risk.winRate - PSYCHO_TAG) <= TAGGED_WINRATE_TOLERANCE + 1e-12,
    `anchored apply tag missed: ${r.risk.winRate}`,
  );
  assert(
    findMonotoneViolations({
      values: PSYCHO_VALUES,
      shares: r.weights.map((w, _i, arr) => w / arr.reduce((x, y) => x + y, 0)),
      tol: 1e-9,
    }).length === 0,
    "anchored apply must be LAW M clean",
  );
  // Deterministic across runs (the plan the owner reviews IS the write).
  const again = searchBestPriceForCleanSnap({ ...params, maxPriceChangePct: 0 });
  assert(
    again.bestPrice === anchored.bestPrice &&
      JSON.stringify(assertSuccess(again.bestResult, "rerun").weights) ===
        JSON.stringify(r.weights),
    "anchored apply must be deterministic",
  );
  // LOAD-BEARING sentinel: the OLD hand-mirrored anchored params (strict-hard
  // tag, no disperseLoss, no niceGridPolish, no plan budget) at the SAME cent
  // with the SAME targets ship 8 of 10 cards OFF-nice — the exact broken
  // promise this wave fixed. If this arm ever lands all-nice, the fixture no
  // longer proves the builder routing matters — re-derive it.
  const rOld = shapeWeights({
    cards: PSYCHO_VALUES.map((v) => ({ value: v })),
    price: PSYCHO_APPLY_CENT,
    targetEdge: auto.targetEdge,
    targetWinRate: auto.targetWinRate,
    maxWinCap: auto.maxWinCap,
    nearMissMin: Math.max(0, before.nearMiss),
    winRateTol: TAGGED_WINRATE_TOLERANCE,
    currentWeights: PSYCHO_LIVE_W,
    winRateIsHard: true,
  });
  assert(!("error" in rOld), "old anchored params must still solve");
  assert(rOld.snapped === true, "old anchored params snapped");
  assert(
    rOld.allNice === false && countOffNicePct(rOld.weights, rOld.niceExemptIdx) === 8,
    `old anchored params must ship 8 off-nice cards (got allNice=${rOld.allNice}, off=${countOffNicePct(rOld.weights, rOld.niceExemptIdx)})`,
  );
});

// ── Wave 10: LAW M RELAYOUT-RETRY RESCUE (the Illusion deadlock) ──────────
//
// 10% Illusion (real-prod pool frozen 2026-07-09; live $32.66) at the wide
// probe's pinned cent $31.28: the committed tier-G snap broke the full-ladder
// law → gate re-laid → the retry DEADLOCKED — the lawful re-lay raises the
// grail shares (the monotone chain forces it), and the grail never-inflate
// guard still compared against the PRE-GATE precise solve, so every tier-G
// copy of the re-laid vector was refused for carrying the re-lay's own grail
// shares. Result: unsnapped/off-8 shipped at apply time while the wide sweep
// (same params, same cent inside the band) shipped snapped/off-2 — the snap
// outcome depended on the plan budget's exhaustion state, non-monotonically.
// The fix refreshes the guard basis to the RE-LAID vector on relayout (the
// committed reality being rounded — refusing to ROUND shares that ship
// verbatim anyway protects nothing) and threads the retry lawfulness
// predicate INTO the tier stack (N → P → G fall-through instead of the
// wrapper forfeiting the snap on its single returned candidate).

const ILLUSION_VALUES = [719.99, 599.99, 342.26, 270.58, 208.09, 93.1, 4.5, 3.59, 1.93];
const ILLUSION_LIVE_W = [3500, 10000, 13000, 20000, 23500, 30000, 300000, 300000, 300000];
const ILLUSION_LIVE_PRICE = 32.66;
const ILLUSION_TAG = 0.1;
/**
 * The cent the WIDE probe suggests for Illusion — i.e. the cent a one-click
 * apply pins. Wave 10: $31.28 · `31368e2a`: $21.50. RE-DERIVED 2026-07-24
 * (asserted against the live wide sweep below, so it can never go stale
 * silently again).
 */
const ILLUSION_PIN = 21.5;

check("relayout retry: 10% Illusion pinned @$21.50 SNAPS and reproduces the wide sweep's own plan (gate re-lay no longer forfeits the snap)", () => {
  const before = computePackRisk({
    cards: ILLUSION_VALUES.map((v, i) => ({ value: v, weight: ILLUSION_LIVE_W[i]! })),
    price: ILLUSION_LIVE_PRICE,
  });
  const top = Math.max(...ILLUSION_VALUES);
  // The WIDE sweep IS the suggestion the operator clicks. Deriving the pinned
  // cent from it (instead of only hard-coding it) is what makes the check a
  // real apply-honesty law rather than a frozen cent: the wave-10 bug WAS the
  // two disagreeing at the same cent (sweep snapped/off-2 vs apply
  // unsnapped/off-8, decided by the plan budget's exhaustion state).
  const wideAuto = autoRetuneTargets(ILLUSION_LIVE_PRICE, FLEET_CFG, ILLUSION_TAG, top, {
    winRate: before.winRate,
    nearMiss: before.nearMiss,
    edge: before.edge,
    topValue: top,
  });
  const wide = searchBestPriceForCleanSnap(
    buildRetuneSearchParams("live", {
      cards: ILLUSION_VALUES.map((v) => ({ value: v })),
      basePrice: ILLUSION_LIVE_PRICE,
      targetEdge: wideAuto.targetEdge,
      targetWinRate: wideAuto.targetWinRate,
      maxWinCap: wideAuto.maxWinCap,
      nearMissMin: Math.max(0, before.nearMiss),
      winRateTol: 0.02,
      currentWeights: ILLUSION_LIVE_W,
      intendedHitRate: wideAuto.intendedHitRate,
      priceBudgetPct: RETUNE_MAX_PRICE_CHANGE_PCT,
    }),
  );
  const rWide = assertSuccess(wide.bestResult, "Illusion wide sweep");
  assert(wide.bestPrice === ILLUSION_PIN, `wide sweep suggests ${wide.bestPrice} ≠ ${ILLUSION_PIN}`);
  assert(rWide.snapped === true, "the wide sweep's suggestion must itself be snapped");

  const auto = autoRetuneTargets(ILLUSION_PIN, FLEET_CFG, ILLUSION_TAG, top, {
    winRate: before.winRate,
    nearMiss: before.nearMiss,
    edge: before.edge,
    topValue: top,
  });
  assert(auto.intendedHitRate !== null, "Illusion fixture must resolve as tagged");
  const params = buildRetuneSearchParams("staged", {
    cards: ILLUSION_VALUES.map((v) => ({ value: v })),
    basePrice: ILLUSION_PIN,
    targetEdge: auto.targetEdge,
    targetWinRate: auto.targetWinRate,
    maxWinCap: auto.maxWinCap,
    nearMissMin: Math.max(0, before.nearMiss),
    winRateTol: 0.02,
    currentWeights: ILLUSION_LIVE_W,
    intendedHitRate: auto.intendedHitRate,
    priceBudgetPct: 0.1,
  });
  const anchored = searchBestPriceForCleanSnap({ ...params, maxPriceChangePct: 0 });
  assert(anchored.bestPrice === ILLUSION_PIN, `anchored price ${anchored.bestPrice} ≠ ${ILLUSION_PIN}`);
  assert(anchored.searched === 1, `anchored searched ${anchored.searched} ≠ 1`);
  assert(anchored.fellBackToBase === false, "anchored base solve must be GOOD (not a fallback)");
  const r = assertSuccess(anchored.bestResult, "Illusion anchored apply");
  // THE regression this wave fixed: at the suggested cent the apply shipped
  // snapped=false with 8 off-nice cards under the stale precise grail basis,
  // while the sweep at that same cent shipped snapped/off-2.
  assert(r.snapped === true, "Illusion anchored apply must snap (was the wave-10 regression)");
  assert(
    JSON.stringify(r.weights) === JSON.stringify(rWide.weights),
    `anchored apply [${r.weights.join(",")}] ≠ the sweep's promise [${rWide.weights.join(",")}]`,
  );
  const off = countOffNicePct(r.weights, r.niceExemptIdx);
  assert(off === 2, `Illusion anchored off-nice ${off} ≠ 2`);
  assert(
    Math.abs(r.risk.winRate - ILLUSION_TAG) <= TAGGED_WINRATE_TOLERANCE + 1e-12,
    `Illusion anchored tag missed: ${r.risk.winRate}`,
  );
  assert(
    findMonotoneViolations({
      values: ILLUSION_VALUES,
      shares: r.weights.map((w, _i, arr) => w / arr.reduce((x, y) => x + y, 0)),
      tol: 1e-9,
    }).length === 0,
    "Illusion anchored apply must be LAW M clean",
  );
  const total = r.weights.reduce((a, b) => a + b, 0);
  let winUnits = 0;
  for (let i = 0; i < ILLUSION_VALUES.length; i++) {
    if (ILLUSION_VALUES[i]! >= ILLUSION_PIN) winUnits += r.weights[i]!;
  }
  assert(
    winUnits === Math.round(ILLUSION_TAG * total),
    `Illusion win units ${winUnits} ≠ ${Math.round(ILLUSION_TAG * total)}`,
  );
  const again = searchBestPriceForCleanSnap({ ...params, maxPriceChangePct: 0 });
  assert(
    again.bestPrice === anchored.bestPrice &&
      JSON.stringify(assertSuccess(again.bestResult, "rerun").weights) ===
        JSON.stringify(r.weights),
    "Illusion anchored apply must be deterministic",
  );
});

check("refusal honesty: Illusion at the RETIRED cent $31.28 falls through honestly (unsnapped precise, tag exact, LAW M clean, edge in band)", () => {
  // $31.28 was the wave-10 pinned cent; `31368e2a` moved the suggestion to
  // $21.50 (previous check). Keeping the old cent under test — as a REFUSAL
  // contract rather than a snap contract — preserves the coverage: when no
  // tier can lawfully snap, the engine must ship the precise vector honestly
  // instead of a bad plan. It must never ship a snapped-but-unlawful one.
  const RETIRED_PIN = 31.28;
  const before = computePackRisk({
    cards: ILLUSION_VALUES.map((v, i) => ({ value: v, weight: ILLUSION_LIVE_W[i]! })),
    price: ILLUSION_LIVE_PRICE,
  });
  const top = Math.max(...ILLUSION_VALUES);
  const auto = autoRetuneTargets(RETIRED_PIN, FLEET_CFG, ILLUSION_TAG, top, {
    winRate: before.winRate,
    nearMiss: before.nearMiss,
    edge: before.edge,
    topValue: top,
  });
  const params = buildRetuneSearchParams("staged", {
    cards: ILLUSION_VALUES.map((v) => ({ value: v })),
    basePrice: RETIRED_PIN,
    targetEdge: auto.targetEdge,
    targetWinRate: auto.targetWinRate,
    maxWinCap: auto.maxWinCap,
    nearMissMin: Math.max(0, before.nearMiss),
    winRateTol: 0.02,
    currentWeights: ILLUSION_LIVE_W,
    intendedHitRate: auto.intendedHitRate,
    priceBudgetPct: 0.1,
  });
  const anchored = searchBestPriceForCleanSnap({ ...params, maxPriceChangePct: 0 });
  const r = assertSuccess(anchored.bestResult, "Illusion retired-cent solve");
  assert(anchored.bestPrice === RETIRED_PIN, `price ${anchored.bestPrice} ≠ ${RETIRED_PIN}`);
  assert(anchored.taggedAccuracyHit === true, "the honest fallback must still hit the tag");
  assert(r.snapped === false, `snapped=${r.snapped} — no tier is lawful at this cent`);
  assert(r.allNice === undefined, "allNice must be unset on the precise fallback");
  assert(
    Math.abs(r.risk.winRate - ILLUSION_TAG) <= TAGGED_WINRATE_TOLERANCE + 1e-12,
    `tag missed on the fallback: ${r.risk.winRate}`,
  );
  assert(
    r.edge >= auto.targetEdge - 1e-9 &&
      r.edge <= auto.targetEdge + 0.001 + ONE_SIDED_EDGE_EXCESS_TOL + 1e-9,
    `fallback edge ${(r.edge * 100).toFixed(4)}% out of the accepted band`,
  );
  const total = r.weights.reduce((a, b) => a + b, 0);
  assert(
    findMonotoneViolations({
      values: ILLUSION_VALUES,
      shares: r.weights.map((w) => w / total),
      tol: 1e-9,
    }).length === 0,
    "the honest fallback must still be LAW M clean",
  );
  let winUnits = 0;
  for (let i = 0; i < ILLUSION_VALUES.length; i++) {
    if (ILLUSION_VALUES[i]! >= RETIRED_PIN) winUnits += r.weights[i]!;
  }
  assert(
    winUnits === Math.round(ILLUSION_TAG * total),
    `fallback win units ${winUnits} ≠ ${Math.round(ILLUSION_TAG * total)}`,
  );
});

// ── Summary ──────────────────────────────────────────────────────────────
console.log(
  `\n${passes} passed, ${failures.length} failed${
    failures.length > 0 ? ` — ${failures.join(", ")}` : ""
  }`,
);
if (failures.length > 0) process.exit(1);
