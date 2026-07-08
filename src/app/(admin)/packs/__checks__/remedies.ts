/**
 * Retune V3 GUIDANCE harness — pin remedies + tag-fit verdict (pure, no DB).
 *
 * Run with:
 *   npx tsx "src/app/(admin)/packs/__checks__/remedies.ts"
 *
 * Pins every contract of the V3 guidance layer (tag-guidance.ts):
 *
 *   1.  `computePinRemedies` — when a pinned retune REFUSES, the advisor
 *       returns the smallest SOLVER-VERIFIED single-pin changes (raise /
 *       lower / unpin) + an in-budget price move; every remedy re-applies
 *       through `shapeWeights` (checked independently here); an accepting
 *       base returns []; a fully-interlocked pin set returns [] with the
 *       honest "pins interlock" copy via `pinShortfallHumanCopy`.
 *   2.  THE TAILS? FIXTURES (the owner's real "Tails?" pool shape, $432.50),
 *       under LAW M (Retune V3): every remedy must yield a plan the monotone
 *       gate accepts — a "fix" whose plan is a zigzag is not a remedy.
 *       A5 = EV-short pins (choked 3419.40 win pin + over-weighted 20.02
 *       dust pin) — the pre-law raise-c1 lead (1%→1.85%) died with the law:
 *       its plan loaded the $194.10 dust card heavier than the $61.46 one
 *       (chain-capped EV tops out at $375.43 vs the $384.15 floor). Lawful
 *       catalog, empirically pinned: raise c5 10%→23.5%, lower c8 55%→20.5%,
 *       price-move $389.25 — every plan re-verified LAW-M-clean here.
 *       C2 = EV-heavy pins (inflated jackpot) — exactly ONE remedy: lower
 *       c0 2%→0.64% (the acceptance is an ISLAND ≈[0.55%, 0.64%] — the
 *       dense scan + the LAW M rescue ladder land it; 0.65% refuses).
 *       B = fully pinned at a dead-zero edge — NO single-pin change
 *       (interlock).
 *   3.  tagged1pct remedy threshold: the $250 jackpot pin on the 1% lottery
 *       verifies tag-HARD only at ≤ 0.057% under LAW M — the remedy lands
 *       exactly there (grid-snapped), the re-applied solve holds the tag at
 *       1.0000%, and 0.058% refuses (the boundary is real).
 *   4.  `monotoneFitLocal` — the honest-ladder window: exact band math,
 *       never-inflate caps (saturated residual rides the CHEAPEST winner
 *       only), grail running-min ratchet, pinned point-mass carve,
 *       structural nulls.
 *   5.  SHAPE-UNFIT lead (Love-Cycle): a 50/50 tag no honest ladder carries
 *       at the plan price leads with the VERIFIED untag (solver round-trip,
 *       ranked ABOVE the price levers); 10% Chaos keeps its legacy kinds
 *       byte-identical (live rate == tag gates the lead off).
 *
 * Exit code 0 = all passed; 1 = at least one failure (printed).
 */

import {
  TAGGED_WINRATE_TOLERANCE,
  computePackRisk,
  findMonotoneViolations,
  searchBestPriceForCleanSnap,
  type ShapeWeightsPinnedShare,
  type ShapeWeightsResult,
  type ShapeWeightsSuccess,
} from "../../insights/edge-calc/risk";
import {
  autoMaxWinCap,
  autoRetuneTargets,
  autoTargetEdge,
  type ResolvedAutoTargetCfg,
} from "../_lib/auto-targets";
import {
  computePinRemedies,
  computeTagGuidance,
  monotoneFitLocal,
  pinShortfallHumanCopy,
  type PinRemedy,
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

// ── Fixtures: the Tails? pool ($432.50, live 20% winners) ────────────────

const CFG: ResolvedAutoTargetCfg = { globalCap: 25000, maxMultCeiling: 100 };
const TAILS = {
  price: 432.5,
  values: [9602.51, 3419.4, 1680, 1079.99, 815.65, 406.2, 194.1, 61.46, 20.02],
  livePcts: [0.5, 2, 4, 6, 7.5, 10, 10, 10, 50],
};
const tailsWeights = TAILS.livePcts.map((p) => Math.round(p * 10000));
const tailsBefore = computePackRisk({
  cards: TAILS.values.map((v, i) => ({ value: v, weight: tailsWeights[i]! })),
  price: TAILS.price,
});
const tailsTop = Math.max(...TAILS.values);
const tailsT = autoRetuneTargets(TAILS.price, CFG, undefined, tailsTop, {
  winRate: tailsBefore.winRate,
  nearMiss: tailsBefore.nearMiss,
  edge: tailsBefore.edge,
  topValue: tailsTop,
});
const tailsInput = {
  cards: TAILS.values.map((v) => ({ value: v })),
  currentWeights: tailsWeights.slice(),
  price: TAILS.price,
  targetEdge: tailsT.targetEdge,
  targetWinRate: tailsT.targetWinRate,
  nearMissMin: tailsT.nearMissMin,
  maxWinCap: tailsT.maxWinCap,
};

/** A5 — EV-SHORT pins: 3419.40 choked 2%→1%, the 20.02 dust over-pinned at
 * 55%; free cards: c6 ($194.10) and c7 ($61.46). Refuses `pins-infeasible`
 * (≈$26.52 of EV short) at $432.50. */
const PINS_A5: ShapeWeightsPinnedShare[] = [
  { index: 0, share: 0.005 },
  { index: 1, share: 0.01 },
  { index: 2, share: 0.04 },
  { index: 3, share: 0.06 },
  { index: 4, share: 0.075 },
  { index: 5, share: 0.1 },
  { index: 8, share: 0.55 },
];
/** C2 — EV-HEAVY pins: the jackpot inflated 0.5%→2% (≈$121 over budget). */
const PINS_C2: ShapeWeightsPinnedShare[] = PINS_A5.map((p) =>
  p.index === 0
    ? { index: 0, share: 0.02 }
    : p.index === 1
      ? { index: 1, share: 0.02 }
      : p,
);
/** B — FULLY pinned at a point EV of $529.50 (edge −22.4%): interlocked. */
const PINS_B: ShapeWeightsPinnedShare[] = [
  { index: 0, share: 0.02 },
  { index: 1, share: 0.02 },
  { index: 2, share: 0.04 },
  { index: 3, share: 0.06 },
  { index: 4, share: 0.075 },
  { index: 5, share: 0.1 },
  { index: 6, share: 0.1 },
  { index: 7, share: 0.1 },
  { index: 8, share: 0.485 },
];

/** The refused verify a remedy claims to fix — replayed here INDEPENDENTLY
 * of computePinRemedies (defense in depth), through the SAME engine the
 * server retune runs at this exact price (band 0): hard hold → soft float →
 * LAW M rescue. */
function tailsVerify(
  pins: readonly ShapeWeightsPinnedShare[],
  price = TAILS.price,
): ShapeWeightsSuccess | null {
  const s = searchBestPriceForCleanSnap({
    cards: TAILS.values.map((v) => ({ value: v })),
    basePrice: price,
    targetEdge: tailsT.targetEdge,
    targetWinRate: tailsT.targetWinRate,
    maxWinCap: tailsT.maxWinCap,
    nearMissMin: tailsT.nearMissMin,
    winRateTol: 0.02,
    maxPriceChangePct: 0,
    currentWeights: tailsWeights.slice(),
    holdWinRateHard: true,
    disperseLoss: true,
    ...(pins.length > 0 ? { pinnedShares: pins.map((p) => ({ ...p })) } : {}),
  });
  const r = s.bestResult;
  if (!("error" in r) && r.edge >= tailsT.targetEdge - 1e-9) return r;
  return null;
}

const remA5 = computePinRemedies({
  ...tailsInput,
  pinnedShares: PINS_A5,
  maxRemedies: 10,
});

// ── 1. A5: refused base → a verified LAWFUL remedy catalog ───────────────
check("A5 (EV-short): base refuses; every remedy is solver-verified, typed and LAW-M-lawful", () => {
  assert(tailsVerify(PINS_A5) === null, "the A5 base must refuse at $432.50");
  assert(remA5.length === 3, `expected the 3-remedy lawful catalog, got ${remA5.length}`);
  for (const r of remA5) {
    assert(r.verified === true, `${r.kind} must carry verified:true`);
    assert(r.edge >= tailsT.targetEdge - 1e-9, `${r.kind} landed edge below target`);
    if (r.kind === "price-move") {
      assert(typeof r.price === "number" && r.price > 0, "price-move carries a price");
    } else {
      assert(
        typeof r.cardIndex === "number" && typeof r.fromPct === "number",
        `${r.kind} carries cardIndex + fromPct`,
      );
    }
    // Every surviving remedy's PLAN is lawful end to end (the whole point).
    let pins2 = PINS_A5.map((p) => ({ ...p }));
    let price2 = TAILS.price;
    if (r.kind === "raise-pin" || r.kind === "lower-pin") {
      pins2 = pins2.map((p) =>
        p.index === r.cardIndex ? { index: p.index, share: (r.toPct ?? 0) / 100 } : p,
      );
    } else if (r.kind === "unpin-card") {
      pins2 = pins2.filter((p) => p.index !== r.cardIndex);
    } else if (r.kind === "price-move") {
      price2 = r.price!;
    }
    const v = tailsVerify(pins2, price2);
    assert(v !== null, `${r.kind} must re-verify independently`);
    let total = 0;
    for (const w of v.weights) if (w > 0) total += w;
    const shares = v.weights.map((w) => w / total);
    assert(
      findMonotoneViolations({
        values: TAILS.values,
        shares,
        pinnedIdx: new Set(pins2.map((p) => p.index)),
      }).length === 0,
      `${r.kind}'s plan obeys LAW M`,
    );
  }
});

check("A5 lead remedy: raise the under-weighted 406.20 near-miss pin 10% → 23.5% (the pre-law zigzag lead is dead)", () => {
  const lead = remA5[0]!;
  assert(lead.kind === "raise-pin", `lead kind ${lead.kind}`);
  assert(lead.cardIndex === 5 && lead.cardValue === 406.2, "lead targets c5 ($406.20)");
  assert(Math.abs((lead.fromPct ?? 0) - 10) < 1e-9, `fromPct ${lead.fromPct}`);
  assert(
    Math.abs((lead.toPct ?? 0) - 23.5) < 1e-9,
    `toPct must grid-snap to 23.5 (got ${lead.toPct})`,
  );
  assert(
    /raise the pinned \$406\.20/i.test(lead.humanCopy),
    `copy names the card — got: ${lead.humanCopy}`,
  );
  // THE LAW M KILL, pinned as a regression guard: the pre-law lead (raise
  // the choked $3,419.40 pin 1% → 1.85%) only ever "verified" through a plan
  // that loaded the $194.10 dust card heavier than the $61.46 one — the
  // free-dust chain caps that contract's EV at $375.43, below the $384.15
  // floor. It must refuse today, at 1.85% and at the old boundary 1.80%.
  const raiseC1 = (toPct: number) =>
    PINS_A5.map((p) => (p.index === 1 ? { index: 1, share: toPct / 100 } : { ...p }));
  assert(tailsVerify(raiseC1(1.85)) === null, "the pre-law raise-c1 remedy stays dead (1.85%)");
  assert(tailsVerify(raiseC1(1.8)) === null, "…and at 1.80%");
});

check("A5 catalog: exactly {raise c5 10%→23.5%, lower c8 55%→20.5%, price-move $389.25} — no unpins survive the law", () => {
  const kinds = remA5.map((r) => `${r.kind}${r.cardIndex !== undefined ? `@c${r.cardIndex}` : ""}`);
  assert(
    JSON.stringify(kinds) === JSON.stringify(["raise-pin@c5", "lower-pin@c8", "price-move"]),
    `catalog must be [raise-pin@c5, lower-pin@c8, price-move] — got ${JSON.stringify(kinds)}`,
  );
  const r8 = remA5.find((r) => r.kind === "lower-pin")!;
  assert(
    Math.abs((r8.toPct ?? 0) - 20.5) < 1e-9,
    `lower c8 → 20.5 (got ${r8.toPct})`,
  );
  const pm = remA5.find((r) => r.kind === "price-move")!;
  assert(
    Math.abs((pm.price ?? 0) - 389.25) < 1e-9,
    `price-move must land the nearest in-budget verifying cent $389.25 (got ${pm.price})`,
  );
  assert(
    !remA5.some((r) => r.kind === "unpin-card"),
    "no single unpin yields a lawful plan here",
  );
  // Pins with NO single-change fix get NOTHING: c0 (jackpot at live — its
  // unpin breaks the win band) never appears.
  assert(
    remA5.every((r) => r.kind === "price-move" || r.cardIndex !== 0),
    "c0 has no verified remedy and must not appear",
  );
});

check("A5 remedies re-apply INDEPENDENTLY through the engine (lower c8 held exact, price-move, boundary)", () => {
  const applyPin = (idx: number, toPct: number) =>
    PINS_A5.map((p) => (p.index === idx ? { index: idx, share: toPct / 100 } : { ...p }));
  const r8 = tailsVerify(applyPin(8, 20.5));
  assert(r8 !== null, "lower c8 → 20.5% must re-verify");
  let total = 0;
  for (const w of r8.weights) if (w > 0) total += w;
  assert(
    Math.abs(r8.weights[8]! / total - 0.205) <= 1e-9,
    `the lowered pin must be HELD at 20.5% (got ${(r8.weights[8]! / total) * 100}%)`,
  );
  assert(tailsVerify(PINS_A5, 389.25) !== null, "price-move $389.25 must re-verify with ALL pins held");
  // And the boundary is real: half a display step ABOVE the accepted grid
  // value still refuses (21% refuses; 20.5% is the largest verifying step).
  assert(tailsVerify(applyPin(8, 21)) === null, "21% (one step above) must still refuse");
});

check("A5 default cap: maxRemedies defaults to 4 — a no-op on the 3-remedy lawful catalog (still the ranked prefix)", () => {
  const capped = computePinRemedies({ ...tailsInput, pinnedShares: PINS_A5 });
  assert(capped.length === 3, `default cap keeps all three remedies, got ${capped.length}`);
  const key = (r: PinRemedy) => `${r.kind}:${r.cardIndex ?? ""}:${r.toPct ?? ""}:${r.price ?? ""}`;
  assert(
    JSON.stringify(capped.map(key)) === JSON.stringify(remA5.slice(0, 4).map(key)),
    "the capped list must be the ranked prefix",
  );
});

// ── 2. C2: EV-heavy pins → exactly one remedy (an acceptance ISLAND) ─────
check("C2 (EV-heavy): exactly ONE remedy — lower the inflated jackpot pin 2% → 0.64% (island found, plan lawful)", () => {
  const rem = computePinRemedies({ ...tailsInput, pinnedShares: PINS_C2, maxRemedies: 10 });
  assert(rem.length === 1, `expected exactly 1 remedy, got ${rem.length}: ${rem.map((r) => r.kind).join(",")}`);
  const r = rem[0]!;
  assert(r.kind === "lower-pin" && r.cardIndex === 0, `kind ${r.kind} c${r.cardIndex}`);
  assert(Math.abs((r.fromPct ?? 0) - 2) < 1e-9, `fromPct ${r.fromPct}`);
  assert(Math.abs((r.toPct ?? 0) - 0.64) < 1e-9, `toPct must grid-snap to 0.64 (got ${r.toPct})`);
  // The adjust supersedes the unpin for the same card (one remedy per pin).
  assert(!rem.some((x) => x.kind === "unpin-card"), "no unpin rides alongside a verified adjust");
  // The acceptance is an ISLAND (≈[0.55%, 0.64%] on this axis — LAW M
  // feasibility is NOT monotone along a pin share): the re-apply verifies
  // with a LAWFUL plan while 0.65% (one step above) still refuses.
  const applied = PINS_C2.map((p) => (p.index === 0 ? { index: 0, share: 0.0064 } : p));
  const v = tailsVerify(applied);
  assert(v !== null, "lower c0 → 0.64% must re-verify");
  let total = 0;
  for (const w of v.weights) if (w > 0) total += w;
  const shares = v.weights.map((w) => w / total);
  assert(
    findMonotoneViolations({
      values: TAILS.values,
      shares,
      pinnedIdx: new Set(applied.map((p) => p.index)),
    }).length === 0,
    "the remedied plan obeys LAW M (the pre-law zigzag is gone)",
  );
  const short = PINS_C2.map((p) => (p.index === 0 ? { index: 0, share: 0.0065 } : p));
  assert(tailsVerify(short) === null, "0.65% (one step above) must still refuse");
});

// ── 3. B: fully pinned, dead edge → the interlock verdict ────────────────
check("B (fully pinned, edge −22.4%): NO remedy exists — [] + the interlock copy", () => {
  const rem = computePinRemedies({ ...tailsInput, pinnedShares: PINS_B, maxRemedies: 10 });
  assert(rem.length === 0, `expected [], got ${rem.map((r) => r.kind).join(",")}`);
  const copy = pinShortfallHumanCopy({
    price: TAILS.price,
    targetEdge: tailsT.targetEdge,
    remedies: rem,
  });
  assert(/pins interlock/i.test(copy), `copy must carry the interlock verdict — got: ${copy}`);
  assert(/unpin two or more/i.test(copy), "copy points at the multi-pin way out");
  assert(copy.includes("$432.50") && copy.includes("11.08%"), "copy names price + target");
});

check("pinShortfallHumanCopy: refusal detail rides along + the smallest verified fix leads", () => {
  const copy = pinShortfallHumanCopy({
    price: TAILS.price,
    targetEdge: tailsT.targetEdge,
    refusalDetail: "the pins leave EV $26.5201 (≈6.132pp of edge) SHORT of the budget",
    remedies: remA5,
  });
  assert(copy.includes("$26.5201"), "the engine's authoritative $ figure must ride along");
  assert(/Smallest verified fix: Raise the pinned \$406\.20/i.test(copy), `the lead remedy leads — got: ${copy}`);
  assert(/2 more verified options available/.test(copy), "the catalog depth is named");
});

// ── 4. tagged1pct: the remedy threshold on a LOTTERY tag ─────────────────
const T1 = {
  cards: [250, 100, 75, 0.05, 0.02].map((v) => ({ value: v })),
  currentWeights: [500, 3500, 6000, 600000, 390000],
  price: 1.0,
  targetEdge: 0.11,
  targetWinRate: 0.01,
  nearMissMin: 0,
  maxWinCap: 2300,
  intendedHitRate: 0.01,
};

check("tagged1pct: the $250 jackpot pin at 0.5% refuses → remedy lowers it to the 0.057% threshold, tag held HARD", () => {
  const rem = computePinRemedies({
    ...T1,
    pinnedShares: [{ index: 0, share: 0.005 }],
    maxRemedies: 10,
  });
  assert(rem.length === 1, `expected exactly 1 remedy, got ${rem.length}`);
  const r = rem[0]!;
  assert(r.kind === "lower-pin" && r.cardIndex === 0, `kind ${r.kind} c${r.cardIndex}`);
  assert(
    Math.abs((r.toPct ?? 0) - 0.057) < 1e-9,
    `toPct must land the empirically-known LAW-M threshold 0.057% (got ${r.toPct})`,
  );
  // Re-apply through the SAME engine the server runs (band 0, tagged core +
  // LAW M rescue): tag lands exactly 1%.
  const verifyT1 = (pinShare: number): ShapeWeightsResult => {
    const s = searchBestPriceForCleanSnap({
      cards: T1.cards.map((c) => ({ value: c.value })),
      basePrice: T1.price,
      targetEdge: T1.targetEdge,
      targetWinRate: T1.targetWinRate,
      taggedWinRate: T1.targetWinRate,
      maxWinCap: T1.maxWinCap,
      nearMissMin: T1.nearMissMin,
      winRateTol: TAGGED_WINRATE_TOLERANCE,
      maxPriceChangePct: 0,
      currentWeights: T1.currentWeights.slice(),
      disperseLoss: true,
      pinnedShares: [{ index: 0, share: pinShare }],
    });
    return s.bestResult;
  };
  const applied = assertSuccess(verifyT1(0.00057), "re-apply the tagged remedy");
  assert(
    Math.abs(applied.risk.winRate - 0.01) <= TAGGED_WINRATE_TOLERANCE + 1e-12,
    `tag must hold at 1% (got ${(applied.risk.winRate * 100).toFixed(4)}%)`,
  );
  assert(applied.edge >= T1.targetEdge - 1e-9, "edge ≥ target under the remedy");
  // One grid step up (0.058%) refuses — the threshold is real. (The pre-law
  // threshold 0.068% refuses too: its plan broke the monotone ladder.)
  assert("error" in verifyT1(0.00058), "0.058% must still refuse (the threshold is real)");
  assert("error" in verifyT1(0.00068), "the pre-law 0.068% threshold stays dead");
});

check("tagged1pct: an ACCEPTING base returns [] (nothing to repair)", () => {
  const rem = computePinRemedies({
    ...T1,
    pinnedShares: [{ index: 0, share: 0.0005 }],
  });
  assert(rem.length === 0, `expected [], got ${rem.length}`);
});

// ── 5. monotoneFitLocal: the honest-ladder window ────────────────────────
check("monotoneFitLocal: exact window math (win at live cap + NM floor + cheap-heavy loss)", () => {
  // Win {12 @ cap 0.1} · NM {3} · dust {0.4}; tag 0.1, nmMin 0.1.
  // evMin = 0.1·12 + 0.1·3 + 0.8·0.4 = 1.82 (loss excess on the CHEAPEST);
  // evMax = 0.1·12 + 0.45·3 + 0.45·0.4 = 2.73 (uniform loss).
  const w = monotoneFitLocal({
    cards: [{ value: 12 }, { value: 3 }, { value: 0.4 }],
    currentWeights: [100000, 200000, 700000],
    price: 5,
    cap: 100,
    winMass: 0.1,
    nearMissMin: 0.1,
  });
  assert(w !== null, "window exists");
  assert(Math.abs(w.evMin - 1.82) < 1e-9, `evMin ${w.evMin}`);
  assert(Math.abs(w.evMax - 2.73) < 1e-9, `evMax ${w.evMax}`);
  const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
  assert(Math.abs(sum(w.minShares) - 1) < 1e-9 && Math.abs(sum(w.maxShares) - 1) < 1e-9, "witnesses sum to 1");
  assert(w.minShares[0] === 0.1 && w.maxShares[0] === 0.1, "the winner sits AT its live cap in both witnesses");
  assert(w.minShares[1]! < w.maxShares[1]!, "NM floor vs uniform separates the bounds");
});

check("monotoneFitLocal: saturated tag → the forced residual rides ONLY the cheapest winner (never-inflate)", () => {
  // Caps 0.02 + 0.03 < tag 0.2 → residual 0.15 lands on the CHEAPEST ($8);
  // the rich $12 card NEVER exceeds its live 0.02. Saturated ⇒ point window.
  const w = monotoneFitLocal({
    cards: [{ value: 12 }, { value: 8 }, { value: 0.4 }],
    currentWeights: [20000, 30000, 950000],
    price: 5,
    cap: 100,
    winMass: 0.2,
    nearMissMin: 0,
  });
  assert(w !== null, "window exists");
  assert(Math.abs(w.evMin - w.evMax) < 1e-12, "saturated win band ⇒ point window");
  assert(Math.abs(w.evMin - 2.0) < 1e-9, `point ${w.evMin} (win 1.68 + dust 0.32)`);
  assert(w.minShares[0] === 0.02 && w.maxShares[0] === 0.02, "the RICH winner stays at live");
  assert(Math.abs(w.minShares[1]! - 0.18) < 1e-12, "the cheapest carries cap + residual (0.03 + 0.15)");
});

check("monotoneFitLocal: grail running-min ratchet caps a richer grail at the cheaper grail's live odds", () => {
  // Both winners ≥ 5·price are grails; the $30's live 1% ratchets the $100
  // down from live 5% to 1%.
  const w = monotoneFitLocal({
    cards: [{ value: 100 }, { value: 30 }, { value: 0.4 }],
    currentWeights: [50000, 10000, 940000],
    price: 5,
    cap: 1000,
    winMass: 0.1,
    nearMissMin: 0,
  });
  assert(w !== null, "window exists");
  assert(
    w.minShares[0] === 0.01 && w.maxShares[0] === 0.01,
    `the $100 grail is ratcheted to the $30's 1% (got ${w.maxShares[0]})`,
  );
  assert(Math.abs(w.minShares[1]! - 0.09) < 1e-12, "the cheapest grail carries its cap + the residual");
});

check("monotoneFitLocal: pinned point-mass carve + structural null arms", () => {
  // Pin the NM card at 15%: its mass/EV leave the free bands; the only free
  // loss card is the dust → both loss layouts coincide ⇒ point window
  // 0.1·12 + 0.15·3 + 0.75·0.4 = 1.95.
  const pinned = monotoneFitLocal({
    cards: [{ value: 12 }, { value: 3 }, { value: 0.4 }],
    currentWeights: [100000, 200000, 700000],
    price: 5,
    cap: 100,
    winMass: 0.1,
    nearMissMin: 0.1,
    pinnedShares: [{ index: 1, share: 0.15 }],
  });
  assert(pinned !== null, "pinned window exists");
  assert(
    Math.abs(pinned.evMin - 1.95) < 1e-9 && Math.abs(pinned.evMax - 1.95) < 1e-9,
    `pinned point window 1.95 (got [${pinned.evMin}, ${pinned.evMax}])`,
  );
  assert(
    pinned.minShares[1] === 0.15 && pinned.maxShares[1] === 0.15,
    "the pin sits verbatim in both witnesses",
  );
  // Structural nulls: win mass with every winner cap-dropped; loss mass with
  // no loss card; pinned masses over budget.
  assert(
    monotoneFitLocal({
      cards: [{ value: 10 }, { value: 0.05 }],
      currentWeights: [0, 100],
      price: 5,
      cap: 4,
      winMass: 0.2,
      nearMissMin: 0,
    }) === null,
    "cap-dropped-only win band ⇒ null",
  );
  assert(
    monotoneFitLocal({
      cards: [{ value: 10 }],
      currentWeights: [100],
      price: 5,
      cap: 100,
      winMass: 0.2,
      nearMissMin: 0,
    }) === null,
    "loss mass with no loss card ⇒ null",
  );
  assert(
    monotoneFitLocal({
      cards: [{ value: 10 }, { value: 0.05 }],
      currentWeights: [100, 900],
      price: 5,
      cap: 100,
      winMass: 0.1,
      nearMissMin: 0,
      pinnedShares: [{ index: 0, share: 0.25 }],
    }) === null,
    "pinned win mass over the tag ⇒ null",
  );
});

// ── 6. SHAPE-UNFIT lead (Love-Cycle) + legacy protection (10% Chaos) ─────
const LOVE = {
  price: 189.93,
  values: [834, 810.07, 719.99, 650.6, 600, 540, 453, 376.79, 208.09, 205.37, 152.9, 0.29],
  livePcts: [1.25, 1.25, 1.5, 1.9, 2.5, 3.4, 4.5, 4.7, 8.3, 9.2, 11.5, 50],
};

check("Love-Cycle (50/50, live 38.5%): shape-unfit → the VERIFIED untag leads, ranked above the price levers", () => {
  const w = LOVE.livePcts.map((p) => Math.round(p * 10000));
  const before = computePackRisk({
    cards: LOVE.values.map((v, i) => ({ value: v, weight: w[i]! })),
    price: LOVE.price,
  });
  const cap = autoMaxWinCap(LOVE.price, CFG, 0.5);
  const top = Math.max(...LOVE.values.filter((v) => v <= cap));
  const g = computeTagGuidance({
    cards: LOVE.values.map((v) => ({ value: v })),
    currentWeights: w,
    price: LOVE.price,
    targetEdge: autoTargetEdge({ price: LOVE.price, maxWin: top }),
    tag: 0.5,
    nearMissMin: Math.max(0, before.nearMiss),
    maxWinCap: cap,
    cfg: CFG,
    liveWinRate: before.winRate,
    liveNearMiss: before.nearMiss,
  });
  assert(!g.feasibility.feasible, "the 50/50 tag is infeasible at $189.93");
  assert(g.feasibility.shapeFit !== undefined, "the tag-fit verdict is present");
  assert(
    g.feasibility.shapeFit!.monotoneFeasible === false,
    "no honest ladder pays 50% here — monotone-unfit",
  );
  assert(g.feasibility.shapeFit!.monotoneEvMin > 0, "the honest window is reported");
  const kinds = g.suggestions.map((s) => s.kind);
  assert(kinds[0] === "untag", `the untag LEADS (got ${JSON.stringify(kinds)})`);
  const lead = g.suggestions[0]!;
  assert(lead.proof.solverVerified === true, "the lead untag is solver-verified");
  assert(lead.proof.feasibleAfter === true, "the lead untag is a real solve, not an identity note");
  assert(/doesn't fit/i.test(lead.humanCopy), `the copy names the shape verdict — got: ${lead.humanCopy}`);
  assert(/38\.50%/.test(lead.humanCopy), "the copy names the live rate");
  assert(kinds.includes("price-move"), "the price lever is still offered");
  assert(
    kinds.indexOf("price-move") > 0,
    "…but ranked BELOW the identity fix",
  );
  assert(
    g.suggestions.filter((s) => s.kind === "untag" || s.kind === "retag").length === 1,
    "exactly ONE identity suggestion (the verified lead replaces the legacy unverified entry)",
  );
});

check("10% Chaos (live == tag): the lead is gated OFF — legacy kinds byte-identical", () => {
  const CHAOS = {
    price: 4.38,
    values: [905.83, 180, 86.21, 80.82, 52.91, 41.39, 35.65, 25.16, 20.21, 17.62, 14.84, 0.01],
    livePcts: [0.1, 0.1, 0.8, 0.35, 0.25, 0.4, 0.6, 1.2, 0.9, 2.1, 3.2, 90],
    tag: 0.1,
  };
  const w = CHAOS.livePcts.map((p) => Math.round(p * 10000));
  const b = computePackRisk({
    cards: CHAOS.values.map((v, i) => ({ value: v, weight: w[i]! })),
    price: CHAOS.price,
  });
  const tc = autoRetuneTargets(CHAOS.price, CFG, CHAOS.tag, Math.max(...CHAOS.values), {
    winRate: b.winRate,
    nearMiss: b.nearMiss,
    edge: b.edge,
    topValue: Math.max(...CHAOS.values),
  });
  const g = computeTagGuidance({
    cards: CHAOS.values.map((v) => ({ value: v })),
    currentWeights: w,
    price: CHAOS.price,
    targetEdge: tc.targetEdge,
    tag: CHAOS.tag,
    nearMissMin: Math.max(0, b.nearMiss),
    maxWinCap: tc.maxWinCap,
    cfg: CFG,
    liveWinRate: b.winRate,
    liveNearMiss: b.nearMiss,
  });
  assert(
    JSON.stringify(g.suggestions.map((s) => s.kind)) ===
      JSON.stringify(["price-move", "edge-bump", "repair-monotone"]),
    `legacy kinds must be unchanged — got ${JSON.stringify(g.suggestions.map((s) => s.kind))}`,
  );
  assert(g.feasibility.shapeFit !== undefined, "the verdict field is still reported");
});

check("healthy tagged pool: feasible + monotone-fit ⇒ no identity suggestions at all", () => {
  // Win {30 @ live 10%} carries the tag exactly (point 3.0); two-card NM +
  // dust bands give the engine loss-side freedom (window ≈ [3.34, 3.62]) and
  // the honest ladder even more ([3.365, 4.22]). evTarget 5·0.72 = 3.60 sits
  // inside BOTH — feasible AND monotone-fittable, despite the live rate
  // sitting far off the tag.
  const g = computeTagGuidance({
    cards: [{ value: 30 }, { value: 3 }, { value: 2.6 }, { value: 0.4 }, { value: 0.1 }],
    currentWeights: [100000, 100000, 100000, 350000, 350000],
    price: 5,
    targetEdge: 0.28,
    tag: 0.1,
    nearMissMin: 0.1,
    maxWinCap: 100,
    liveWinRate: 0.3, // far off the tag — yet feasible pools never retag
    liveNearMiss: 0.2,
  });
  assert(g.feasibility.feasible, "the pool is feasible");
  assert(g.feasibility.shapeFit?.monotoneFeasible === true, "…and monotone-fittable");
  assert(
    !g.suggestions.some((s) => s.kind === "untag" || s.kind === "retag"),
    "no identity suggestion on a feasible pool",
  );
});

// ── Summary ─────────────────────────────────────────────────────────────
console.log(
  `\n${passes} passed, ${failures.length} failed${
    failures.length > 0 ? ` — ${failures.join(", ")}` : ""
  }`,
);
if (failures.length > 0) process.exit(1);
