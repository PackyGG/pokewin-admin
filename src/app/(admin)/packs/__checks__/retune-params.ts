/**
 * Retune V2 plan≡write param-parity harness.
 *
 * Run with:
 *   npx tsx "src/app/(admin)/packs/__checks__/retune-params.ts"
 *
 * NO DB, NO React, NO server imports — imports ONLY the pure
 * `buildRetuneSearchParams` constructor and the dep-free risk module. Pins
 * the ONE-BRAIN invariant of the Retune V2 workspace: the object
 * `buildRetuneSearchParams` produces is DEEP-EQUAL (same keys, same values,
 * ABSENT keys stay absent) to what each MAIN write arm sends into
 * `searchBestPriceForCleanSnap`:
 *
 *   • LIVE arm  — `applyPackRetune`'s solve (V2 default levers: no upward
 *     extension, no price anchor, no preferHigherEdge).
 *   • STAGED arm — `applyStagedPackEditAndRetune`'s solve (staged price
 *     anchor, live weights with 0 for staged-in cards).
 *
 * Fixtures cover tagged AND untagged pools on both arms, plus the
 * pinned-away-from-tag case (tagged gate must stay OFF). Because the write
 * paths pin the previewed price with tolerance 0 (`approvedPriceAfter`), ANY
 * param skew between plan and write is a production refusal — this harness
 * makes the shared shape a regression-tested contract:
 *
 *   1.  Live untagged: full expected object, byte-for-byte key set.
 *   2.  Live tagged (1% pack): + `taggedWinRate` = the target win-rate.
 *   3.  Staged untagged incl. a staged-IN card (anchor weight 0).
 *   4.  Staged tagged (5% pack): + `taggedWinRate`.
 *   5.  Tagged pack, win-rate pinned AWAY from the tag → NO `taggedWinRate`.
 *   6.  Both arms carry the resolved `priceBudgetPct` as the search band
 *       (default ±10% — `RETUNE_PRICE_BUDGET_DEFAULT_PCT`), NOT the flat ±60%
 *       constant; a configured budget clamps into (0, ±60%].
 *   7.  Neither arm emits `preferHigherEdge` / a non-zero upward extension.
 *   8.  `isOnCleanLadderPct` (the `offLadderCards` brain): ladder rungs read
 *       true (incl. reconstructed integer-weight pcts), off-ladder residuals
 *       read false.
 *
 * Exit code 0 = all passed; 1 = at least one failure (printed).
 */

import {
  buildRetuneSearchParams,
  mapPinnedOddsToShares,
  type RetuneSearchInputs,
} from "../_lib/retune-params";
import {
  RETUNE_MAX_PRICE_CHANGE_PCT,
  RETUNE_PRICE_BUDGET_DEFAULT_PCT,
  TAGGED_WINRATE_TOLERANCE,
  isOnCleanLadderPct,
} from "../../insights/edge-calc/risk";
import {
  SELECTABLE_TAG_HIT_RATES,
  hitRateFromTags,
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

/**
 * Strict structural deep-equality: same type, same OWN key sets (an absent
 * key is NOT equal to an `undefined` one — `searchBestPriceForCleanSnap`
 * branches on key presence for `taggedWinRate`), same primitive values
 * (numbers must be bit-identical — the write pins are tolerance 0).
 */
function deepEqual(a: unknown, b: unknown, path = "$"): void {
  if (Object.is(a, b)) return;
  if (Array.isArray(a) || Array.isArray(b)) {
    assert(
      Array.isArray(a) && Array.isArray(b),
      `${path}: array vs non-array`,
    );
    assert(a.length === b.length, `${path}: length ${a.length} !== ${b.length}`);
    for (let i = 0; i < a.length; i++) deepEqual(a[i], b[i], `${path}[${i}]`);
    return;
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const ka = Object.keys(a as Record<string, unknown>).sort();
    const kb = Object.keys(b as Record<string, unknown>).sort();
    assert(
      ka.join(",") === kb.join(","),
      `${path}: key sets differ — [${ka.join(",")}] vs [${kb.join(",")}]`,
    );
    for (const k of ka) {
      deepEqual(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        `${path}.${k}`,
      );
    }
    return;
  }
  throw new Error(`${path}: ${String(a)} !== ${String(b)}`);
}

// ── Fixtures ────────────────────────────────────────────────────────────
// Values shaped like real prod pools (a dust card, a near-miss, a win, a
// grail); targets shaped like the auto-resolver's output.

/** Untagged live pool: 4 cards at a $2.50 ticket, default 20% win-rate. */
const liveUntagged: RetuneSearchInputs = {
  cards: [{ value: 0.35 }, { value: 1.8 }, { value: 4.2 }, { value: 120 }],
  basePrice: 2.5,
  targetEdge: 0.1105,
  targetWinRate: 0.2,
  maxWinCap: 250,
  nearMissMin: 0.1,
  winRateTol: 0.02,
  currentWeights: [880000, 90000, 29900, 100],
  intendedHitRate: null,
  priceBudgetPct: RETUNE_PRICE_BUDGET_DEFAULT_PCT,
};

/** Tagged live pool: a "1%" lottery pack — target win-rate IS the tag. */
const liveTagged: RetuneSearchInputs = {
  ...liveUntagged,
  basePrice: 1.25,
  targetWinRate: 0.01,
  intendedHitRate: 0.01,
};

/**
 * Staged pool: one live card kept (live weight), one staged-IN card (anchor
 * 0), solved at the operator's staged price.
 */
const stagedUntagged: RetuneSearchInputs = {
  cards: [{ value: 0.4 }, { value: 3.1 }, { value: 55 }],
  basePrice: 3.33,
  targetEdge: 0.1099,
  targetWinRate: 0.2,
  maxWinCap: 333,
  nearMissMin: 0.1,
  winRateTol: 0.02,
  currentWeights: [910000, 89000, 0], // last card staged-in → 0 anchor
  intendedHitRate: null,
  priceBudgetPct: RETUNE_PRICE_BUDGET_DEFAULT_PCT,
};

/** Staged tagged pool: a "5%" pack, staged price, tag-exact target. */
const stagedTagged: RetuneSearchInputs = {
  ...stagedUntagged,
  targetWinRate: 0.05,
  intendedHitRate: 0.05,
};

/**
 * What `applyPackRetune` (live) / `applyStagedPackEditAndRetune` (staged)
 * send into `searchBestPriceForCleanSnap` — the write-arm contract this
 * harness pins the builder against. Replicates the write sites' construction
 * semantics: base fields verbatim, the SHARED ±60% band, upward extension 0,
 * NO preferHigherEdge, `taggedWinRate` present iff the resolved target
 * value-equals the tag, and — LAW 15 (ruleset §0) — the STRICT solver
 * tolerance ({@link TAGGED_WINRATE_TOLERANCE}, 0.01pp) whenever the tagged
 * gate is active (the loose 0.02 default legally drifted a 1% tag to 1.072%
 * through the clean-snap acceptance gate).
 */
function writeArmSends(i: RetuneSearchInputs): Record<string, unknown> {
  const tagged =
    i.intendedHitRate !== null &&
    Math.abs(i.intendedHitRate - i.targetWinRate) < 1e-9;
  return {
    cards: i.cards,
    basePrice: i.basePrice,
    targetEdge: i.targetEdge,
    targetWinRate: i.targetWinRate,
    maxWinCap: i.maxWinCap,
    nearMissMin: i.nearMissMin,
    winRateTol: tagged ? TAGGED_WINRATE_TOLERANCE : i.winRateTol,
    currentWeights: i.currentWeights,
    // The retune band is the caller's price budget, clamped into
    // [0.0001, RETUNE_MAX_PRICE_CHANGE_PCT] — NOT the flat ±60% constant. The
    // full ±60% survives only as the wide SUGGESTION probe.
    maxPriceChangePct: Math.min(
      Math.max(i.priceBudgetPct, 0.0001),
      RETUNE_MAX_PRICE_CHANGE_PCT,
    ),
    upwardPriceExtensionPct: 0,
    ...(tagged ? { taggedWinRate: i.targetWinRate } : {}),
    // WIN-RATE HOLD (owner-lens item 4): untagged retunes hold the achieved
    // win-rate within +5pp of the design (no-op / absent in tagged mode).
    ...(tagged ? {} : { holdWinRate: true }),
    // LOSS-MASS DISPERSION (owner-lens item 10): every retune re-spreads the
    // free-dust loss band at fixed mass + EV (present on both tagged + untagged).
    disperseLoss: true,
    // Owner pins (Retune V2): the write threads {cardId, pct} pins through the
    // SAME builder as the plan; the emitted solver vector is {index, share},
    // resolved against the SAME cards array and sorted by index.
    ...(i.pinnedOdds !== undefined && i.pinnedOdds.length > 0
      ? { pinnedShares: mapPinnedOddsToShares(i.cards, i.pinnedOdds) }
      : {}),
  };
}

// ── 1-2. Live arm parity ────────────────────────────────────────────────
check("live untagged: builder deep-equals the applyPackRetune send", () => {
  deepEqual(buildRetuneSearchParams("live", liveUntagged), writeArmSends(liveUntagged));
});

check("live tagged (1%): builder deep-equals the send incl. taggedWinRate", () => {
  const built = buildRetuneSearchParams("live", liveTagged);
  deepEqual(built, writeArmSends(liveTagged));
  assert(
    (built as Record<string, unknown>).taggedWinRate === 0.01,
    "taggedWinRate must be the resolved target win-rate (the tag)",
  );
});

// ── 3-4. Staged arm parity ──────────────────────────────────────────────
check("staged untagged (incl. staged-in 0 anchor): builder deep-equals the send", () => {
  deepEqual(
    buildRetuneSearchParams("staged", stagedUntagged),
    writeArmSends(stagedUntagged),
  );
});

check("staged tagged (5%): builder deep-equals the send incl. taggedWinRate", () => {
  deepEqual(
    buildRetuneSearchParams("staged", stagedTagged),
    writeArmSends(stagedTagged),
  );
});

// ── 5. Tagged gate is VALUE equality — pinned-away disables it ──────────
check("tagged pack with win-rate pinned away from the tag → NO taggedWinRate key", () => {
  const pinnedAway: RetuneSearchInputs = {
    ...liveTagged,
    targetWinRate: 0.2, // operator pinned 20% on a 1%-tagged pack
  };
  const built = buildRetuneSearchParams("live", pinnedAway);
  assert(
    !("taggedWinRate" in built),
    "taggedWinRate must be ABSENT when the target diverges from the tag",
  );
  deepEqual(built, writeArmSends(pinnedAway));
});

// ── 6. The band IS the price budget on BOTH arms (default ±10%) ─────────
check("both arms carry the resolved price budget as the band (default ±10%)", () => {
  const live = buildRetuneSearchParams("live", liveUntagged);
  const staged = buildRetuneSearchParams("staged", stagedUntagged);
  assert(
    live.maxPriceChangePct === RETUNE_PRICE_BUDGET_DEFAULT_PCT,
    `live arm must carry the price budget (got ${live.maxPriceChangePct}, want ${RETUNE_PRICE_BUDGET_DEFAULT_PCT})`,
  );
  assert(
    staged.maxPriceChangePct === RETUNE_PRICE_BUDGET_DEFAULT_PCT,
    `staged arm must carry the price budget (got ${staged.maxPriceChangePct})`,
  );
  assert(
    Math.abs(RETUNE_PRICE_BUDGET_DEFAULT_PCT - 0.1) < 1e-12,
    "the default budget is ±10%",
  );
  assert(
    Math.abs(RETUNE_MAX_PRICE_CHANGE_PCT - 0.6) < 1e-12,
    "the SUGGESTION-band hard cap is still ±60%",
  );
});

// ── 6b. The budget is threaded verbatim, clamped into (0, ±60%] ────────
check("price budget threads through as the band and clamps at the ±60% hard cap", () => {
  // A pass-through mid budget survives verbatim on both arms.
  const passThrough = buildRetuneSearchParams("live", {
    ...liveUntagged,
    priceBudgetPct: 0.25,
  });
  assert(
    passThrough.maxPriceChangePct === 0.25,
    `a 0.25 budget must pass through as the band (got ${passThrough.maxPriceChangePct})`,
  );
  // A configured budget above the ±60% cap clamps DOWN to the hard cap.
  const overCap = buildRetuneSearchParams("staged", {
    ...stagedUntagged,
    priceBudgetPct: 0.9,
  });
  assert(
    overCap.maxPriceChangePct === RETUNE_MAX_PRICE_CHANGE_PCT,
    `a 0.9 budget must clamp to ±60% (got ${overCap.maxPriceChangePct})`,
  );
  // A non-positive/degenerate budget clamps UP to the positive floor (never 0
  // or negative — the search needs a real band).
  const zero = buildRetuneSearchParams("live", {
    ...liveUntagged,
    priceBudgetPct: 0,
  });
  const zeroBand = zero.maxPriceChangePct ?? -1;
  assert(
    zeroBand > 0 && zeroBand < 0.001,
    `a 0 budget must clamp UP to the positive floor (got ${zero.maxPriceChangePct})`,
  );
});

// ── 7. No edge-vs-snap lever leaks out of the builder ───────────────────
check("builder never emits preferHigherEdge and pins upward extension to 0", () => {
  for (const [arm, fixture] of [
    ["live", liveTagged],
    ["staged", stagedTagged],
  ] as const) {
    const built = buildRetuneSearchParams(arm, fixture);
    assert(
      !("preferHigherEdge" in built),
      `${arm}: preferHigherEdge must be absent (snap-first — clean odds are a MUST)`,
    );
    assert(
      built.upwardPriceExtensionPct === 0,
      `${arm}: upwardPriceExtensionPct must be 0`,
    );
  }
});

// ── 7b. LAW 15 — the tagged gate carries the STRICT solver tolerance ────
check("tagged gate forces winRateTol = TAGGED_WINRATE_TOLERANCE (LAW 15); untagged keeps 0.02", () => {
  const taggedBuilt = buildRetuneSearchParams("live", liveTagged);
  assert(
    taggedBuilt.winRateTol === TAGGED_WINRATE_TOLERANCE,
    `tagged solve must carry the strict 0.01pp solver tolerance (got ${taggedBuilt.winRateTol})`,
  );
  const untaggedBuilt = buildRetuneSearchParams("live", liveUntagged);
  assert(
    untaggedBuilt.winRateTol === 0.02,
    `untagged solve keeps the caller's 0.02 (got ${untaggedBuilt.winRateTol})`,
  );
  // Pinned-away-from-tag disables the gate AND the tolerance tighten.
  const pinnedAway = buildRetuneSearchParams("live", {
    ...liveTagged,
    targetWinRate: 0.2,
  });
  assert(
    pinnedAway.winRateTol === 0.02,
    "pinned-away-from-tag keeps the soft tolerance (tagged mode fully off)",
  );
});

// ── 7c. Owner pins (Retune V2) — plan≡write INCLUDING the pin vector ─────
check("pinned staged fixture: builder deep-equals the send incl. pinnedShares (sorted by index)", () => {
  const pinnedStaged: RetuneSearchInputs = {
    cards: [
      { value: 0.4, cardId: "c-dust" },
      { value: 3.1, cardId: "c-win" },
      { value: 55, cardId: "c-grail" },
    ],
    basePrice: 3.33,
    targetEdge: 0.1099,
    targetWinRate: 0.2,
    maxWinCap: 333,
    nearMissMin: 0.1,
    winRateTol: 0.02,
    currentWeights: [910000, 89000, 0],
    intendedHitRate: null,
    priceBudgetPct: RETUNE_PRICE_BUDGET_DEFAULT_PCT,
    // Deliberately UNSORTED input — the emitted vector must be index-sorted
    // so plan and write are deep-equal regardless of pin insertion order.
    pinnedOdds: [
      { cardId: "c-grail", pct: 0.05 },
      { cardId: "c-dust", pct: 40 },
    ],
  };
  const built = buildRetuneSearchParams("staged", pinnedStaged);
  deepEqual(built, writeArmSends(pinnedStaged));
  const shares = (built as Record<string, unknown>).pinnedShares as {
    index: number;
    share: number;
  }[];
  assert(Array.isArray(shares) && shares.length === 2, "two pins emitted");
  assert(
    shares[0]!.index === 0 && shares[1]!.index === 2,
    "pinnedShares must be sorted by card index",
  );
  assert(
    shares[0]!.share === 0.4 && shares[1]!.share === 0.0005,
    "pct → share is pct/100 exactly",
  );
});

check("no pins → the pinnedShares key is ABSENT (legacy param objects byte-identical)", () => {
  const built = buildRetuneSearchParams("live", liveUntagged);
  assert(
    !("pinnedShares" in built),
    "pinnedShares must be absent when no pins exist",
  );
  const emptyPins = buildRetuneSearchParams("live", {
    ...liveUntagged,
    pinnedOdds: [],
  });
  assert(
    !("pinnedShares" in emptyPins),
    "an EMPTY pinnedOdds array must also emit no key",
  );
});

// ── 8. isOnCleanLadderPct — the offLadderCards brain ────────────────────
check("isOnCleanLadderPct: rungs true, residuals false, degenerates false", () => {
  // Exact ladder rungs across the dynamic range (percent units).
  for (const rung of [0.0001, 0.05, 0.075, 1, 1.5, 2.5, 7.5, 10, 25, 50, 75, 100]) {
    assert(isOnCleanLadderPct(rung), `rung ${rung}% must read ON-ladder`);
  }
  // Reconstructed pct from snapped integer weights (weight/Σweight×100):
  // 0.05% at the snap's ×10000 scale → 500 / 1_000_000 → float division noise.
  assert(
    isOnCleanLadderPct((500 / 1_000_000) * 100),
    "reconstructed 0.05% (integer-weight division) must read ON-ladder",
  );
  // Typical off-ladder buffer residuals / precise-fallback values.
  for (const dirty of [0.0521, 1.735, 47.3, 62.5, 99.9999, 11.53]) {
    assert(!isOnCleanLadderPct(dirty), `${dirty}% must read OFF-ladder`);
  }
  // Degenerate inputs never read clean.
  for (const bad of [0, -1, 100.0001, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert(!isOnCleanLadderPct(bad), `${bad} must read OFF-ladder`);
  }
});

// ── 9. Tag control (owner feature, 2026-07-04) — tag → hit-rate mapping ──
// The workspace tag control stages an override carrying {tag, hitRate}; the
// write path RE-DERIVES hitRate from the tag (never trusts the client), then
// resolves the plan's intended hit-rate the SAME way the untouched-tag path
// does (hitRateFromTags). This pins that the two derivations agree, so the tag
// a push writes to packs.tags and the win-rate the plan solved against can't
// drift. Also guards the selectable set against a typo'd mapping.
check("selectable tag table: tag → hitRate is internally consistent", () => {
  const expected: Record<string, number> = {
    pct1: 0.01,
    pct5: 0.05,
    pct10: 0.1,
    fifty50: 0.5,
  };
  assert(
    SELECTABLE_TAG_HIT_RATES.length === 4,
    `expected 4 selectable tags, got ${SELECTABLE_TAG_HIT_RATES.length}`,
  );
  for (const t of SELECTABLE_TAG_HIT_RATES) {
    assert(
      expected[t.tag] !== undefined,
      `unexpected selectable tag "${t.tag}"`,
    );
    assert(
      Math.abs(t.hitRate - expected[t.tag]!) < 1e-12,
      `tag ${t.tag}: hitRate ${t.hitRate} !== ${expected[t.tag]}`,
    );
  }
});

check("tag override: the pct tags round-trip through hitRateFromTags (DB label)", () => {
  // The tag control writes the enum NAME to packs.tags; the LIVE/plan read path
  // (getPacksPoolComposition) reads it back as the DB-string label via raw SQL
  // and resolves it with hitRateFromTags. Pin that every selectable tag's DB
  // label resolves back to the SAME hit-rate the override solved against — so a
  // pushed tag and a later untagged-read win-rate target agree.
  //
  // ASYMMETRY (pinned deliberately): the `50/50` DB label resolves (via
  // parseArbitraryTag's ratio arm), but the `fifty50` ENUM name does NOT
  // (hitRateFromTags returns null — see risk.ts). The tag control never relies
  // on the enum-name read: it solves from the override's own hitRate, and the
  // raw-SQL live path reads the DB label. So the DB-label round-trip is the
  // contract that matters.
  for (const t of SELECTABLE_TAG_HIT_RATES) {
    const fromDb = hitRateFromTags([t.dbLabel]);
    assert(
      fromDb !== null && Math.abs(fromDb - t.hitRate) < 1e-12,
      `hitRateFromTags(["${t.dbLabel}"]) = ${fromDb} != ${t.hitRate}`,
    );
  }
  // The pct enum names ALSO resolve (both notations share the map); the fifty50
  // enum name is the sole exception (raw-SQL label only).
  assert(hitRateFromTags(["pct1"]) === 0.01, "pct1 enum name → 0.01");
  assert(hitRateFromTags(["pct5"]) === 0.05, "pct5 enum name → 0.05");
  assert(hitRateFromTags(["pct10"]) === 0.1, "pct10 enum name → 0.10");
});

// ── Summary ─────────────────────────────────────────────────────────────
console.log(
  `\n${passes} passed, ${failures.length} failed${
    failures.length > 0 ? ` — ${failures.join(", ")}` : ""
  }`,
);
if (failures.length > 0) process.exit(1);
