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
 *   6.  Both arms share the ±60% band (`RETUNE_MAX_PRICE_CHANGE_PCT`) — the
 *       staged arm's old silent ±25% default is DEAD (owner-sanctioned).
 *   7.  Neither arm emits `preferHigherEdge` / a non-zero upward extension.
 *   8.  `isOnCleanLadderPct` (the `offLadderCards` brain): ladder rungs read
 *       true (incl. reconstructed integer-weight pcts), off-ladder residuals
 *       read false.
 *
 * Exit code 0 = all passed; 1 = at least one failure (printed).
 */

import {
  buildRetuneSearchParams,
  type RetuneSearchInputs,
} from "../_lib/retune-params";
import {
  RETUNE_MAX_PRICE_CHANGE_PCT,
  TAGGED_WINRATE_TOLERANCE,
  isOnCleanLadderPct,
} from "../../insights/edge-calc/risk";

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
    maxPriceChangePct: RETUNE_MAX_PRICE_CHANGE_PCT,
    upwardPriceExtensionPct: 0,
    ...(tagged ? { taggedWinRate: i.targetWinRate } : {}),
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

// ── 6. The ONE shared band on BOTH arms (staged ±25% default is dead) ───
check("both arms carry the shared ±60% retune band", () => {
  const live = buildRetuneSearchParams("live", liveUntagged);
  const staged = buildRetuneSearchParams("staged", stagedUntagged);
  assert(
    live.maxPriceChangePct === RETUNE_MAX_PRICE_CHANGE_PCT,
    "live arm must carry RETUNE_MAX_PRICE_CHANGE_PCT",
  );
  assert(
    staged.maxPriceChangePct === RETUNE_MAX_PRICE_CHANGE_PCT,
    "staged arm must carry RETUNE_MAX_PRICE_CHANGE_PCT (±25% default is dead)",
  );
  assert(
    Math.abs(RETUNE_MAX_PRICE_CHANGE_PCT - 0.6) < 1e-12,
    "the shared band is ±60%",
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

// ── Summary ─────────────────────────────────────────────────────────────
console.log(
  `\n${passes} passed, ${failures.length} failed${
    failures.length > 0 ? ` — ${failures.join(", ")}` : ""
  }`,
);
if (failures.length > 0) process.exit(1);
