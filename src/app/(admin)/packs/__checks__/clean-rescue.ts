/**
 * Retune V3 CLEAN-RESCUE harness (wave 13 — owner grant 2026-07-11, pure, no DB).
 *
 * Run with:
 *   npx tsx "src/app/(admin)/packs/__checks__/clean-rescue.ts"
 *
 * Pins the contracts of `computeCleanRescue` (tag-guidance.ts) — the sweep
 * that rescues a FEASIBLE-but-dirty (snapped=false) plan by flexing the
 * owner-granted levers, least invasive first:
 *
 *   1. Tier A reuse: an already-proven CLEAN wide-probe landing is adopted
 *      with ZERO extra searches (the search fn must never be invoked).
 *   2. Tier A no-op prune: a clean wide probe at (±1¢ of) the current price
 *      is NOT a rescue — the sweep falls through to edge flex.
 *   3. Least-invasive ladder order: edge rungs nearest-first, + before −,
 *      and per rung the IN-BUDGET price band before the WIDE band.
 *   4. Budget law (wave-11): never more than `maxSearches` search calls;
 *      an exhausted sweep returns null (pool edits are then necessary).
 *   5. Pinned price: Tier A skipped even when clean; every candidate runs
 *      with band 0 (base-price-only short-circuit); the rescue keeps the
 *      pinned cent and only flexes edge.
 *   6. Tagged strict-accuracy veto: a clean-snapping candidate that broke
 *      the tag accuracy gate is rejected, never adopted.
 *   7. Edge-grid clamp: candidates ≤ 0.001 (or ≥ 0.9) are never probed.
 *   8. `buildCleanRescueSuggestion`: Tier A → null (the wide probe's own
 *      suggestion carries that price); edge tiers → a `price-edge-exact`
 *      row with the exact {price, edgeTarget} the one-click apply threads.
 *
 * Exit code 0 = all passed; 1 = at least one failure (printed).
 */

import { searchBestPriceForCleanSnap } from "../../insights/edge-calc/risk";
import {
  CLEAN_RESCUE_EDGE_STEP,
  buildCleanRescueSuggestion,
  computeCleanRescue,
  type CleanRescue,
  type ProbeOutcome,
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

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// ── Fixture: a 4-card healthy pool (planned == live ⇒ never degenerate) ────
const VALUES = [50, 20, 5, 1] as const;
const LIVE_SHARES = [0.05, 0.1, 0.25, 0.6] as const;
const BASE_PRICE = 10;
const TARGET_EDGE = 0.06;
const BUDGET_PCT = 0.1;
const WIDE_PCT = 0.6;

type SearchFn = typeof searchBestPriceForCleanSnap;
type SearchResult = ReturnType<SearchFn>;

/** Marker param object — the stub search fn reads the candidate back out. */
function mkParams(
  targetEdge: number,
  bandPct: number,
): Parameters<SearchFn>[0] {
  return {
    cards: VALUES.map((v) => ({ value: v })),
    basePrice: BASE_PRICE,
    targetEdge,
    targetWinRate: 0.15,
    maxPriceChangePct: bandPct,
  };
}

/** A feasible stub landing: healthy weights (== live shares), clean flags. */
function okResult(
  price: number,
  opts?: {
    snapped?: boolean;
    allNice?: boolean;
    taggedAccuracyHit?: boolean | null;
    edge?: number;
  },
): SearchResult {
  return {
    bestPrice: price,
    bestResult: {
      weights: LIVE_SHARES.map((s) => s * 100_000),
      snapped: opts?.snapped ?? true,
      allNice: opts?.allNice ?? true,
      risk: { edge: opts?.edge ?? TARGET_EDGE, winRate: 0.15 },
      relaxations: [],
    },
    searched: 1,
    fellBackToBase: false,
    taggedAccuracyHit: opts?.taggedAccuracyHit ?? null,
    snapNodesSpent: 0,
    usedSoftFallback: false,
  } as unknown as SearchResult;
}

function baseInput(overrides?: {
  pricePinned?: boolean;
  tagged?: boolean;
  wideProbe?: (ProbeOutcome & { edge: number; winRate: number }) | null;
  maxSearches?: number;
  searchFn?: SearchFn;
  targetEdge?: number;
}): Parameters<typeof computeCleanRescue>[0] {
  return {
    mkParams,
    values: [...VALUES],
    liveShares: [...LIVE_SHARES],
    targetEdge: overrides?.targetEdge ?? TARGET_EDGE,
    priceBudgetPct: BUDGET_PCT,
    widePct: WIDE_PCT,
    pricePinned: overrides?.pricePinned ?? false,
    tagged: overrides?.tagged ?? false,
    currentPrice: BASE_PRICE,
    wideProbe: overrides?.wideProbe ?? null,
    ...(overrides?.maxSearches !== undefined
      ? { maxSearches: overrides.maxSearches }
      : {}),
    ...(overrides?.searchFn !== undefined
      ? { searchFn: overrides.searchFn }
      : {}),
  };
}

const CLEAN_WIDE_PROBE: ProbeOutcome & { edge: number; winRate: number } = {
  feasible: true,
  price: 12.1,
  allNice: true,
  snapped: true,
  taggedAccuracyHit: null,
  shapeDegenerate: false,
  offNiceCount: null,
  edge: 0.061,
  winRate: 0.15,
};

// ── 1. Tier A: adopt the already-proven wide landing, zero searches ────────
check("tier A adopts a clean wide probe with zero searches", () => {
  const neverCall: SearchFn = () => {
    throw new Error("searchFn must not be called on the Tier A path");
  };
  const r = computeCleanRescue(
    baseInput({ wideProbe: CLEAN_WIDE_PROBE, searchFn: neverCall }),
  );
  assert(r !== null, "expected a rescue");
  assert(r!.tier === "wide-price", `tier ${r!.tier}`);
  assert(r!.price === 12.1, `price ${r!.price}`);
  assert(r!.edgeTargetOverride === null, "tier A must keep the pack target");
  assert(r!.searchesSpent === 0, `searchesSpent ${r!.searchesSpent}`);
});

check("tier A rejects a dirty / degenerate / off-tag wide probe", () => {
  const calls: number[] = [];
  const stub: SearchFn = (p) => {
    calls.push(p.targetEdge);
    return okResult(BASE_PRICE, { snapped: false });
  };
  for (const probe of [
    { ...CLEAN_WIDE_PROBE, snapped: false },
    { ...CLEAN_WIDE_PROBE, shapeDegenerate: true },
    { ...CLEAN_WIDE_PROBE, feasible: false },
  ]) {
    const r = computeCleanRescue(
      baseInput({ wideProbe: probe, searchFn: stub, maxSearches: 2 }),
    );
    assert(r === null, "a disqualified probe must not be adopted");
  }
  assert(calls.length > 0, "the sweep must still run after Tier A rejects");
});

// ── 2. Tier A no-op prune (clean at the CURRENT price is not a rescue) ─────
check("tier A no-op price falls through to edge flex", () => {
  const stub: SearchFn = (p) => okResult(10.5, { edge: p.targetEdge });
  const r = computeCleanRescue(
    baseInput({
      wideProbe: { ...CLEAN_WIDE_PROBE, price: BASE_PRICE },
      searchFn: stub,
    }),
  );
  assert(r !== null, "expected the edge-flex rescue");
  assert(r!.tier === "edge-flex", `tier ${r!.tier}`);
  assert(
    Math.abs(r!.edgeTargetOverride! - (TARGET_EDGE + CLEAN_RESCUE_EDGE_STEP)) <
      1e-12,
    `nearest + rung first, got ${r!.edgeTargetOverride}`,
  );
  assert(r!.searchesSpent === 1, `searchesSpent ${r!.searchesSpent}`);
});

// ── 3. Least-invasive ladder order ──────────────────────────────────────────
check("sweep order: nearest rung first, + before −, budget before wide", () => {
  const seen: { te: number; band: number }[] = [];
  const stub: SearchFn = (p) => {
    seen.push({ te: p.targetEdge, band: p.maxPriceChangePct ?? -1 });
    return okResult(BASE_PRICE, { snapped: false });
  };
  const r = computeCleanRescue(baseInput({ searchFn: stub, maxSearches: 12 }));
  assert(r === null, "always-dirty stub must yield null");
  const expected: { te: number; band: number }[] = [];
  for (let k = 1; k <= 3; k++) {
    for (const sign of [1, -1]) {
      const te = TARGET_EDGE + sign * k * CLEAN_RESCUE_EDGE_STEP;
      expected.push({ te, band: BUDGET_PCT }, { te, band: WIDE_PCT });
    }
  }
  assert(seen.length === 12, `expected 12 searches, got ${seen.length}`);
  for (let i = 0; i < expected.length; i++) {
    assert(
      Math.abs(seen[i]!.te - expected[i]!.te) < 1e-12 &&
        Math.abs(seen[i]!.band - expected[i]!.band) < 1e-12,
      `call ${i}: got (${seen[i]!.te}, ${seen[i]!.band}), want (${expected[i]!.te}, ${expected[i]!.band})`,
    );
  }
});

check("a wide-band landing reports tier edge-flex-wide", () => {
  let n = 0;
  const stub: SearchFn = (p) => {
    n++;
    // Reject the in-budget attempt, accept the wide attempt of rung +0.25pp.
    return okResult(13.9, {
      snapped: (p.maxPriceChangePct ?? 0) === WIDE_PCT,
      edge: p.targetEdge,
    });
  };
  const r = computeCleanRescue(baseInput({ searchFn: stub }));
  assert(r !== null, "expected a rescue");
  assert(r!.tier === "edge-flex-wide", `tier ${r!.tier}`);
  assert(r!.price === 13.9, `price ${r!.price}`);
  assert(r!.searchesSpent === 2 && n === 2, `spent ${r!.searchesSpent}/${n}`);
});

// ── 4. Budget law ───────────────────────────────────────────────────────────
check("budget: exhausted sweep returns null at exactly maxSearches", () => {
  let n = 0;
  const stub: SearchFn = () => {
    n++;
    return okResult(BASE_PRICE, { snapped: false });
  };
  const r = computeCleanRescue(baseInput({ searchFn: stub, maxSearches: 5 }));
  assert(r === null, "expected null");
  assert(n === 5, `expected exactly 5 searches, got ${n}`);
});

// ── 5. Pinned price: edge flex only, at the pinned cent ────────────────────
check("pinned price: tier A skipped, band always 0, price kept", () => {
  const bands: number[] = [];
  const stub: SearchFn = (p) => {
    bands.push(p.maxPriceChangePct ?? -1);
    return okResult(BASE_PRICE, { edge: p.targetEdge });
  };
  const r = computeCleanRescue(
    baseInput({
      pricePinned: true,
      wideProbe: CLEAN_WIDE_PROBE, // clean — but a pin outranks it
      searchFn: stub,
    }),
  );
  assert(r !== null, "expected the pinned edge-flex rescue");
  assert(r!.tier === "edge-flex", `tier ${r!.tier}`);
  assert(r!.price === BASE_PRICE, `price ${r!.price} (must keep the pin)`);
  assert(
    bands.every((b) => b === 0),
    `every band must be 0, got ${bands.join(",")}`,
  );
  assert(r!.edgeTargetOverride !== null, "edge override expected");
});

// ── 6. Tagged strict-accuracy veto ──────────────────────────────────────────
check("tagged: a clean snap that broke the accuracy gate is rejected", () => {
  let n = 0;
  const stub: SearchFn = (p) => {
    n++;
    // First candidate: clean but off-tag. Second: clean and on-tag.
    return okResult(10.75, {
      taggedAccuracyHit: n === 1 ? false : true,
      edge: p.targetEdge,
    });
  };
  const r = computeCleanRescue(baseInput({ tagged: true, searchFn: stub }));
  assert(r !== null, "expected a rescue on the second candidate");
  assert(r!.searchesSpent === 2, `spent ${r!.searchesSpent}`);
  assert(
    Math.abs(r!.edgeTargetOverride! - (TARGET_EDGE + CLEAN_RESCUE_EDGE_STEP)) <
      1e-12,
    "same rung, wide band (in-budget attempt was the off-tag one)",
  );
});

// ── 7. Edge-grid clamp ──────────────────────────────────────────────────────
check("grid clamp: rungs at or below 0.001 are never probed", () => {
  const probed: number[] = [];
  const stub: SearchFn = (p) => {
    probed.push(p.targetEdge);
    return okResult(BASE_PRICE, { snapped: false });
  };
  computeCleanRescue(
    baseInput({ targetEdge: 0.002, searchFn: stub, maxSearches: 24 }),
  );
  assert(probed.length > 0, "sweep must probe the + rungs");
  assert(
    probed.every((te) => te > 0.001),
    `probed an out-of-range rung: ${probed.join(",")}`,
  );
  assert(
    probed.every((te) => te > 0.002),
    "only + rungs fit a 0.2% target (− rungs clamp away)",
  );
});

// ── 8. Suggestion builder ───────────────────────────────────────────────────
check("suggestion: tier A → null; edge tiers → price-edge-exact row", () => {
  const tierA: CleanRescue = {
    tier: "wide-price",
    price: 12.1,
    edgeTargetOverride: null,
    landedEdge: 0.061,
    landedWinRate: 0.15,
    allNice: true,
    searchesSpent: 0,
  };
  assert(
    buildCleanRescueSuggestion(tierA, BASE_PRICE) === null,
    "tier A must not mint a second price row",
  );
  const flex: CleanRescue = {
    tier: "edge-flex",
    price: 10.5,
    edgeTargetOverride: TARGET_EDGE + CLEAN_RESCUE_EDGE_STEP,
    landedEdge: 0.0625,
    landedWinRate: 0.15,
    allNice: true,
    searchesSpent: 1,
  };
  const s = buildCleanRescueSuggestion(flex, BASE_PRICE);
  assert(s !== null, "expected a suggestion");
  assert(s!.kind === "price-edge-exact", `kind ${s!.kind}`);
  assert(Number(s!.params.price) === 10.5, `price ${s!.params.price}`);
  assert(
    Math.abs(Number(s!.params.edgeTarget) - flex.edgeTargetOverride!) < 1e-12,
    `edgeTarget ${s!.params.edgeTarget}`,
  );
  assert(Number(s!.params.autoClean) === 1, "autoClean marker expected");
  assert(s!.humanCopy.startsWith("Auto-clean:"), s!.humanCopy);
  assert(s!.proof.solverVerified === true, "solver-verified proof expected");
});

// ── Summary ─────────────────────────────────────────────────────────────
console.log(
  `\n${passes} passed, ${failures.length} failed${
    failures.length > 0 ? ` — ${failures.join(", ")}` : ""
  }`,
);
if (failures.length > 0) process.exit(1);
