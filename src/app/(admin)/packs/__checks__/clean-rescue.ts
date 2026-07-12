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
 *   9. Tier P pin-repair (owner 2026-07-11, the hand-proven move): after
 *      the edge-flex ladder fails OR starves its budget, the few off-ladder
 *      landed rows are pinned to their nearest clean rungs (cheapest total
 *      nudge first, Cartesian combos) and re-verified at the pack's OWN
 *      edge target under tier P's OWN budget; on-grid landings and >4
 *      off-rows skip the tier; repairs carry cardIds for the one-click
 *      staging.
 *  10. Tier N (owner 2026-07-12, "works on all packs"): TAGGED pools use the
 *      HUMAN-NICE grid as the off-row detector (exempt rows skipped) and pin
 *      off-nice rows to genuine NICE rungs — catching the snapped=true /
 *      allNice=false state (e.g. 0.047%) the wide probe used to answer with
 *      a stale far-price move. Tagged acceptance everywhere now also
 *      requires `allNice === true`, so a rescue can never land off-nice.
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
  values?: number[];
  liveShares?: number[];
  landedShares?: number[];
  cardIds?: string[];
  maxPinRepairSolves?: number;
  niceExemptIdx?: number[];
  ownerPinnedIdx?: number[];
  mkParams?: Parameters<typeof computeCleanRescue>[0]["mkParams"];
}): Parameters<typeof computeCleanRescue>[0] {
  return {
    mkParams: overrides?.mkParams ?? mkParams,
    values: overrides?.values ?? [...VALUES],
    liveShares: overrides?.liveShares ?? [...LIVE_SHARES],
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
    ...(overrides?.landedShares !== undefined
      ? { landedShares: overrides.landedShares }
      : {}),
    ...(overrides?.cardIds !== undefined
      ? { cardIds: overrides.cardIds }
      : {}),
    ...(overrides?.maxPinRepairSolves !== undefined
      ? { maxPinRepairSolves: overrides.maxPinRepairSolves }
      : {}),
    ...(overrides?.niceExemptIdx !== undefined
      ? { niceExemptIdx: overrides.niceExemptIdx }
      : {}),
    ...(overrides?.ownerPinnedIdx !== undefined
      ? { ownerPinnedIdx: overrides.ownerPinnedIdx }
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

// ── 9. Tier P: pin-repair (the owner's hand-proven move, mechanized) ───────
// Landed rows 4.89% (grid 0.05 ⇒ rungs 4.85/4.9) and 10.11% (grid 0.25 ⇒
// rungs 10.0/10.25) sit off-ladder; 25% and 60% are on-grid. Cheapest total
// nudge = {4.9, 10.0} (Δ 0.12pp) — the FIRST combo tried.
const LANDED_DIRTY = [0.0489, 0.1011, 0.25, 0.6];
const CARD_IDS = ["card-a", "card-b", "card-c", "card-d"];

/** Stub: dirty everywhere EXCEPT when the candidate carries repair pins. */
function pinAcceptingStub(counters: { unpinned: number; pinned: number }): SearchFn {
  return ((p: Parameters<SearchFn>[0]) => {
    const pins = (p as { pinnedShares?: { index: number; share: number }[] })
      .pinnedShares;
    if (pins !== undefined && pins.length > 0) {
      counters.pinned++;
      return okResult(BASE_PRICE + 0.5, { snapped: true });
    }
    counters.unpinned++;
    return okResult(BASE_PRICE, { snapped: false });
  }) as SearchFn;
}

check("tier P: off-ladder rows pinned to nearest rungs at the OWN edge target", () => {
  const n = { unpinned: 0, pinned: 0 };
  const r = computeCleanRescue(
    baseInput({
      searchFn: pinAcceptingStub(n),
      landedShares: LANDED_DIRTY,
      cardIds: CARD_IDS,
    }),
  );
  assert(r !== null, "expected the pin-repair rescue");
  assert(r!.tier === "pin-repair", `tier ${r!.tier}`);
  assert(r!.edgeTargetOverride === null, "tier P must NOT flex the edge target");
  assert(r!.price === BASE_PRICE + 0.5, `price ${r!.price}`);
  const reps = r!.pinRepairs ?? [];
  assert(reps.length === 2, `expected 2 repairs, got ${reps.length}`);
  assert(
    reps[0]!.index === 0 && Math.abs(reps[0]!.pct - 4.9) < 1e-9,
    `repair 0: got ${reps[0]!.index}@${reps[0]!.pct}, want 0@4.9 (nearest rung)`,
  );
  assert(
    reps[1]!.index === 1 && Math.abs(reps[1]!.pct - 10) < 1e-9,
    `repair 1: got ${reps[1]!.index}@${reps[1]!.pct}, want 1@10 (nearest rung)`,
  );
  assert(
    reps[0]!.cardId === "card-a" && reps[1]!.cardId === "card-b",
    "repairs must carry the cardIds for one-click staging",
  );
  assert(n.pinned === 1, `cheapest combo first — ${n.pinned} pinned solves`);
  assert(
    r!.searchesSpent === n.unpinned + n.pinned,
    `searchesSpent ${r!.searchesSpent} != ${n.unpinned + n.pinned}`,
  );
});

check("tier P: reachable AFTER the edge-flex budget starves (the dead-code trap)", () => {
  const n = { unpinned: 0, pinned: 0 };
  const r = computeCleanRescue(
    baseInput({
      searchFn: pinAcceptingStub(n),
      landedShares: LANDED_DIRTY,
      cardIds: CARD_IDS,
      maxSearches: 2,
    }),
  );
  assert(r !== null, "budget exhaustion must fall through to tier P, not null");
  assert(r!.tier === "pin-repair", `tier ${r!.tier}`);
  assert(n.unpinned === 2, `edge-flex stops at its budget — ${n.unpinned}`);
  assert(n.pinned === 1, `tier P runs on its OWN budget — ${n.pinned}`);
});

check("tier P: own combo budget + honest null when no combo verifies", () => {
  let pinned = 0;
  const alwaysDirty: SearchFn = ((p: Parameters<SearchFn>[0]) => {
    const pins = (p as { pinnedShares?: unknown[] }).pinnedShares;
    if (pins !== undefined && pins.length > 0) pinned++;
    return okResult(BASE_PRICE, { snapped: false });
  }) as SearchFn;
  const r = computeCleanRescue(
    baseInput({
      searchFn: alwaysDirty,
      landedShares: LANDED_DIRTY,
      maxSearches: 2,
    }),
  );
  assert(r === null, "no verifying combo ⇒ null (pool edits are next)");
  assert(pinned === 4, `all 4 rung combos tried, got ${pinned}`);
  pinned = 0;
  const r2 = computeCleanRescue(
    baseInput({
      searchFn: alwaysDirty,
      landedShares: LANDED_DIRTY,
      maxSearches: 2,
      maxPinRepairSolves: 1,
    }),
  );
  assert(r2 === null, "starved tier P ⇒ null");
  assert(pinned === 1, `tier P budget honored, got ${pinned}`);
});

check("tier P: skipped on clean landings and on >4 off-ladder rows", () => {
  const n1 = { unpinned: 0, pinned: 0 };
  const clean = computeCleanRescue(
    baseInput({
      searchFn: pinAcceptingStub(n1),
      landedShares: [0.05, 0.1, 0.25, 0.6],
      maxSearches: 2,
    }),
  );
  assert(clean === null && n1.pinned === 0, "on-grid landing ⇒ no tier P solve");
  const n2 = { unpinned: 0, pinned: 0 };
  const tooMany = computeCleanRescue(
    baseInput({
      searchFn: pinAcceptingStub(n2),
      values: [50, 20, 10, 5, 1],
      liveShares: [0.05, 0.1, 0.15, 0.25, 0.45],
      landedShares: [0.0489, 0.1011, 0.1511, 0.2511, 0.4489],
      maxSearches: 2,
    }),
  );
  assert(
    tooMany === null && n2.pinned === 0,
    "5 off-ladder rows exceed the 4-row cap ⇒ tier P never solves",
  );
});

// ── 10. Tier N: tagged off-NICE repair (owner 2026-07-12) ──────────────────
// Landed rows 0.047% (47 per-100k units — off-nice; NICE rungs 40/50 ⇒
// 0.04%/0.05%) and 14.953% (rungs 10%/15%) fail the nice grid; 25% (2.5e4)
// and 50% (5e4) pass — note 60% would NOT (mantissa 6 is not on the grid).
// Cheapest total nudge = {0.05, 15} (Δ 0.003 + 0.047 pp) — first combo.
const LANDED_OFF_NICE = [0.00047, 0.14953, 0.25, 0.5];

check("tier N: tagged off-nice rows pinned to genuine NICE rungs", () => {
  const n = { unpinned: 0, pinned: 0 };
  const r = computeCleanRescue(
    baseInput({
      tagged: true,
      searchFn: pinAcceptingStub(n),
      landedShares: LANDED_OFF_NICE,
      cardIds: CARD_IDS,
    }),
  );
  assert(r !== null, "expected the tier N pin-repair rescue");
  assert(r!.tier === "pin-repair", `tier ${r!.tier}`);
  assert(r!.edgeTargetOverride === null, "tier N must NOT flex the edge target");
  const reps = r!.pinRepairs ?? [];
  assert(reps.length === 2, `expected 2 repairs, got ${reps.length}`);
  assert(
    reps[0]!.index === 0 && Math.abs(reps[0]!.pct - 0.05) < 1e-9,
    `repair 0: got ${reps[0]!.index}@${reps[0]!.pct}, want 0@0.05 (nearest NICE rung)`,
  );
  assert(
    reps[1]!.index === 1 && Math.abs(reps[1]!.pct - 15) < 1e-9,
    `repair 1: got ${reps[1]!.index}@${reps[1]!.pct}, want 1@15 (nearest NICE rung)`,
  );
  assert(n.pinned === 1, `cheapest combo first — ${n.pinned} pinned solves`);
});

check("tier N: exempt rows are never flagged (the allNice judge's own set)", () => {
  const n = { unpinned: 0, pinned: 0 };
  const r = computeCleanRescue(
    baseInput({
      tagged: true,
      searchFn: pinAcceptingStub(n),
      landedShares: LANDED_OFF_NICE,
      cardIds: CARD_IDS,
      niceExemptIdx: [0],
    }),
  );
  assert(r !== null, "expected a rescue on the one non-exempt off row");
  const reps = r!.pinRepairs ?? [];
  assert(
    reps.length === 1 && reps[0]!.index === 1,
    `only row 1 may be repaired, got ${reps.map((p) => p.index).join(",")}`,
  );
});

check("tier N: an all-nice tagged landing never solves pinned combos", () => {
  const n = { unpinned: 0, pinned: 0 };
  const r = computeCleanRescue(
    baseInput({
      tagged: true,
      searchFn: pinAcceptingStub(n),
      // 5% / 15% / 30% / 50% — every rung on the NICE grid.
      landedShares: [0.05, 0.15, 0.3, 0.5],
      maxSearches: 2,
    }),
  );
  assert(r === null, "nothing off-nice ⇒ no tier N rescue");
  assert(n.pinned === 0, `no pinned solves expected, got ${n.pinned}`);
});

// ── 11. Owner pins ride the rescue (owner 2026-07-12) ──────────────────────
// A pool with OWNER pins used to gate the rescue OFF entirely — clicking an
// unpin chip left 2 pins + raw decimals and no auto-clean. Now the pins bake
// into mkParams (caller-side) and: tier A is skipped (probe pin provenance
// unverifiable), every candidate solve carries the owner pins, tier P never
// repairs an owner-pinned row and MERGES its combo pins with the owner's.
check("owner pins: tier A skipped, pins ride every solve, owner rows never repaired", () => {
  // Owner pinned row 0 at an UGLY 4.89% (their sovereign choice); row 1
  // landed off-ladder at 10.11% and is the only repairable row.
  const ownerPin = { index: 0, share: 0.0489 };
  const seenPins: { index: number; share: number }[][] = [];
  const stub: SearchFn = ((p: Parameters<SearchFn>[0]) => {
    const pins =
      (p as { pinnedShares?: { index: number; share: number }[] })
        .pinnedShares ?? [];
    seenPins.push(pins);
    // Accept only when a repair pin joined the owner's (tier P combo).
    return pins.length >= 2
      ? okResult(BASE_PRICE + 0.5, { snapped: true })
      : okResult(BASE_PRICE, { snapped: false });
  }) as SearchFn;
  const r = computeCleanRescue(
    baseInput({
      mkParams: (te, band) => ({
        ...mkParams(te, band),
        pinnedShares: [ownerPin],
      }),
      ownerPinnedIdx: [0],
      wideProbe: CLEAN_WIDE_PROBE, // clean — but owner pins outrank tier A
      searchFn: stub,
      landedShares: LANDED_DIRTY,
      cardIds: CARD_IDS,
    }),
  );
  assert(r !== null, "expected the pin-repair rescue");
  assert(r!.tier === "pin-repair", `tier ${r!.tier} (tier A must be skipped)`);
  const reps = r!.pinRepairs ?? [];
  assert(
    reps.length === 1 && reps[0]!.index === 1 && reps[0]!.cardId === "card-b",
    `only the unpinned row 1 may be repaired, got ${reps
      .map((p) => p.index)
      .join(",")}`,
  );
  assert(
    seenPins.length > 0 &&
      seenPins.every((pins) =>
        pins.some((p) => p.index === 0 && Math.abs(p.share - 0.0489) < 1e-12),
      ),
    "every candidate solve must carry the owner's pin",
  );
  const accepting = seenPins[seenPins.length - 1]!;
  assert(
    accepting.length === 2 &&
      accepting.some((p) => p.index === 1 && Math.abs(p.share - 0.1) < 1e-12),
    `the verifying solve must merge owner + repair pins, got ${JSON.stringify(accepting)}`,
  );
});

check("owner pins: all-owner-ugly landing yields honest null (pins are law)", () => {
  // BOTH off-ladder rows are owner-pinned — nothing is repairable, and the
  // rescue must refuse rather than override the owner's typed odds.
  let comboSolves = 0;
  const stub: SearchFn = ((p: Parameters<SearchFn>[0]) => {
    const pins =
      (p as { pinnedShares?: { index: number; share: number }[] })
        .pinnedShares ?? [];
    if (pins.length > 2) comboSolves++;
    return okResult(BASE_PRICE, { snapped: false });
  }) as SearchFn;
  const r = computeCleanRescue(
    baseInput({
      mkParams: (te, band) => ({
        ...mkParams(te, band),
        pinnedShares: [
          { index: 0, share: 0.0489 },
          { index: 1, share: 0.1011 },
        ],
      }),
      ownerPinnedIdx: [0, 1],
      searchFn: stub,
      landedShares: LANDED_DIRTY,
      cardIds: CARD_IDS,
      maxSearches: 2,
    }),
  );
  assert(r === null, "no repairable row ⇒ null (pool edits are next)");
  assert(comboSolves === 0, `tier P must not probe combos, got ${comboSolves}`);
});

check("tagged acceptance: every tier rejects an allNice=false landing", () => {
  // Tier A: a snapped wide probe that is off-nice must not be adopted.
  const neverCall: SearchFn = (() => {
    return okResult(BASE_PRICE, { snapped: false });
  }) as SearchFn;
  const rA = computeCleanRescue(
    baseInput({
      tagged: true,
      wideProbe: { ...CLEAN_WIDE_PROBE, allNice: false },
      searchFn: neverCall,
      maxSearches: 1,
    }),
  );
  assert(rA === null || rA.tier !== "wide-price", "tier A must reject off-nice");
  // Tier B/C: first candidate snaps but lands off-nice, second is nice.
  let m = 0;
  const stub: SearchFn = ((p: Parameters<SearchFn>[0]) => {
    m++;
    return okResult(10.75, { allNice: m === 1 ? false : true, edge: p.targetEdge });
  }) as SearchFn;
  const rB = computeCleanRescue(baseInput({ tagged: true, searchFn: stub }));
  assert(rB !== null, "expected a rescue on the second (nice) candidate");
  assert(rB!.searchesSpent === 2, `spent ${rB!.searchesSpent}`);
  // Tier N: pinned combos that land off-nice are refused ⇒ honest null.
  let pinnedOffNice = 0;
  const offNiceStub: SearchFn = ((p: Parameters<SearchFn>[0]) => {
    const pins = (p as { pinnedShares?: unknown[] }).pinnedShares;
    if (pins !== undefined && pins.length > 0) {
      pinnedOffNice++;
      return okResult(BASE_PRICE, { snapped: true, allNice: false });
    }
    return okResult(BASE_PRICE, { snapped: false });
  }) as SearchFn;
  const rN = computeCleanRescue(
    baseInput({
      tagged: true,
      searchFn: offNiceStub,
      landedShares: LANDED_OFF_NICE,
      maxSearches: 2,
    }),
  );
  assert(rN === null, "off-nice pinned combos must never be adopted");
  assert(pinnedOffNice === 4, `all 4 combos tried, got ${pinnedOffNice}`);
});

// ── Summary ─────────────────────────────────────────────────────────────
console.log(
  `\n${passes} passed, ${failures.length} failed${
    failures.length > 0 ? ` — ${failures.join(", ")}` : ""
  }`,
);
if (failures.length > 0) process.exit(1);
