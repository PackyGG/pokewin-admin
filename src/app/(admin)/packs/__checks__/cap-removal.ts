/**
 * Retune V2 CAP-REMOVAL harness (pure, no DB).
 *
 * Run with:
 *   npx tsx "src/app/(admin)/packs/__checks__/cap-removal.ts"
 *
 * Owner rule (2026-07-03): a card the solver's max-win-cap pre-filter drops
 * (value > the resolved cap) is a true REMOVAL — the plan classifies it
 * (`PackTunePlan.capDroppedCardIds` via `computeCapDroppedCardIds`), the UI
 * renders it like a staged removal ("removed — over max-win cap $X"), and the
 * write OMITS its row from the `pack_cards` createMany
 * (`omitZeroWeightRows`) instead of persisting a dead 0%-odds row. Recovery =
 * the History snapshot revert, which now restores against the CARDS CATALOG
 * (`partitionSnapshotRestore`), not live-pool membership.
 *
 * HISTORY NOTE (archaeology, 2026-07-03): both write arms had ALWAYS written
 * weight-0 rows verbatim (applyPackRetune since 5e561dd2, the staged write
 * since 22b51604) — the removal is NEW behavior the owner asked for, not a
 * restoration of an earlier one.
 *
 * Pinned contracts:
 *   1.  CLASSIFICATION — the strict engine predicate (value > cap): the
 *       Heavy Hitters fixture classifies exactly the $2,507.35 MASAKI
 *       Machamp; a raised cap classifies nothing.
 *   2.  PLAN — the live-arm solve on the real numbers is FEASIBLE with the
 *       Machamp's shaped weight exactly 0 and max-win $1,107.60 (the drop is
 *       what pulls the jackpot under the $2,185 cap).
 *   3.  WRITE VECTOR — `omitZeroWeightRows` omits exactly the Machamp row,
 *       keeps every other card with a positive weight, and the omitted set
 *       ≡ the classification (plan ≡ write on the same fixture).
 *   4.  PIN ON A CAP-DROPPED CARD — still the `pins-infeasible` refusal with
 *       the raise-cap remedy (mirrors pins.ts §6; the removal design must
 *       not soften it into a silent drop).
 *   5.  NO FALSE POSITIVES — an under-cap pool classifies nothing and its
 *       write vector keeps every row.
 *   6.  REVERT — `partitionSnapshotRestore` restores a snapshot card that is
 *       ABSENT from the live pool but present in the cards catalog (the
 *       recovery path for a cap removal); skips catalog-deleted cards and
 *       legacy weight-0 rows, reported.
 *
 * Exit code 0 = all passed; 1 = at least one failure (printed).
 */

import { searchBestPriceForCleanSnap } from "../../insights/edge-calc/risk";
import {
  DEFAULT_MAX_MULT_CEILING,
  autoRetuneTargets,
  resolveIntendedHitRate,
  type ResolvedAutoTargetCfg,
} from "../_lib/auto-targets";
import {
  buildRetuneSearchParams,
  computeCapDroppedCardIds,
  omitZeroWeightRows,
} from "../_lib/retune-params";
import { partitionSnapshotRestore } from "../_lib/snapshot-restore";

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

// ── The Heavy Hitters fixture (real prod numbers, read-only probe — the
//    same fixture pins.ts §6 carries) ─────────────────────────────────────
const HEAVY_HITTERS = {
  name: "Heavy Hitters",
  tags: ["%1"],
  price: 0.95,
  pool: [
    { cardId: "c-masaki-machamp", value: 2507.35, weight: 30 },
    { cardId: "c-shining-steelix", value: 1107.6, weight: 50 },
    { cardId: "c-snorlax-lvx", value: 956.96, weight: 80 },
    { cardId: "c-regirock-star", value: 896.4, weight: 150 },
    { cardId: "c-shining-tyranitar", value: 840.0, weight: 150 },
    { cardId: "c-golem-skyridge", value: 626.35, weight: 230 },
    { cardId: "c-poliwrath-h24", value: 360.0, weight: 310 },
    { cardId: "c-hariyama-ex", value: 74.68, weight: 1000 },
    { cardId: "c-grapploct-dust", value: 0.05, weight: 998000 },
  ],
};
const CFG: ResolvedAutoTargetCfg = {
  globalCap: 25000,
  maxMultCeiling: DEFAULT_MAX_MULT_CEILING,
};

/** The resolved %1-tag targets at the live $0.95 price (cap ≈ $2,185). */
function heavyHittersTargets() {
  const hitRate = resolveIntendedHitRate(HEAVY_HITTERS.name, HEAVY_HITTERS.tags);
  assert(hitRate === 0.01, `resolved tag ${hitRate}`);
  const poolTop = Math.max(...HEAVY_HITTERS.pool.map((c) => c.value));
  return autoRetuneTargets(HEAVY_HITTERS.price, CFG, hitRate, poolTop);
}

/** The live-arm solve (no pins) — the plan the workspace shows for the pack. */
function heavyHittersSolve() {
  const targets = heavyHittersTargets();
  return {
    targets,
    search: searchBestPriceForCleanSnap(
      buildRetuneSearchParams("live", {
        cards: HEAVY_HITTERS.pool.map((c) => ({
          value: c.value,
          cardId: c.cardId,
        })),
        basePrice: HEAVY_HITTERS.price,
        targetEdge: targets.targetEdge,
        targetWinRate: targets.targetWinRate,
        maxWinCap: targets.maxWinCap,
        // Live near-miss band [0.475, 0.95) is empty → seeded nearMissMin 0.
        nearMissMin: 0,
        winRateTol: 0.02,
        currentWeights: HEAVY_HITTERS.pool.map((c) => c.weight),
        intendedHitRate: targets.intendedHitRate,
      }),
    ),
  };
}

// ── 1. Classification ───────────────────────────────────────────────────

check("classification: the %1 cap at $0.95 drops exactly the $2,507.35 Machamp", () => {
  const targets = heavyHittersTargets();
  assert(
    targets.maxWinCap < 2507.35 && targets.maxWinCap > 2184,
    `the cap must sit just below the Machamp (got $${targets.maxWinCap.toFixed(2)})`,
  );
  const dropped = computeCapDroppedCardIds(
    HEAVY_HITTERS.pool.map((c) => ({ cardId: c.cardId, value: c.value })),
    targets.maxWinCap,
  );
  assert(
    dropped.length === 1 && dropped[0] === "c-masaki-machamp",
    `expected exactly the Machamp, got [${dropped.join(", ")}]`,
  );
});

check("classification: the predicate is STRICT value > cap (a card AT the cap stays)", () => {
  const dropped = computeCapDroppedCardIds(
    [
      { cardId: "at-cap", value: 100 },
      { cardId: "over-cap", value: 100.01 },
    ],
    100,
  );
  assert(
    dropped.length === 1 && dropped[0] === "over-cap",
    `expected only over-cap, got [${dropped.join(", ")}]`,
  );
});

check("classification: a raised cap classifies nothing (raise-cap keeps the card)", () => {
  const dropped = computeCapDroppedCardIds(
    HEAVY_HITTERS.pool.map((c) => ({ cardId: c.cardId, value: c.value })),
    2600,
  );
  assert(dropped.length === 0, `expected none, got [${dropped.join(", ")}]`);
});

// ── 2. Plan (live arm, real numbers) ────────────────────────────────────

check("plan: the live-arm solve is feasible with the Machamp at weight 0 and max-win $1,107.60", () => {
  const { targets, search } = heavyHittersSolve();
  const r = search.bestResult;
  assert(!("error" in r), `expected a plan, got refusal: ${"error" in r ? r.error : ""}`);
  assert(r.weights[0] === 0, `Machamp shaped weight must be 0, got ${r.weights[0]}`);
  assert(
    Math.abs(r.risk.maxWin - 1107.6) < 1e-9,
    `max-win must drop to the $1,107.60 Steelix, got $${r.risk.maxWin.toFixed(2)}`,
  );
  assert(
    r.risk.maxWin <= targets.maxWinCap + 1e-9,
    `max-win must sit under the cap $${targets.maxWinCap.toFixed(2)}`,
  );
});

// ── 3. Write vector (plan ≡ write omission) ─────────────────────────────

check("write: omitZeroWeightRows omits exactly the Machamp row; every kept weight > 0", () => {
  const { targets, search } = heavyHittersSolve();
  const r = search.bestResult;
  assert(!("error" in r), "fixture must solve");
  // Rows exactly as both write arms build them (identity + shaped weight).
  const rows = HEAVY_HITTERS.pool.map((c, i) => ({
    card_id: c.cardId,
    weight: r.weights[i]!,
  }));
  const written = omitZeroWeightRows(rows);
  const writtenIds = new Set(written.map((w) => w.card_id));
  assert(!writtenIds.has("c-masaki-machamp"), "the Machamp row must be omitted");
  assert(
    written.every((w) => w.weight > 0),
    "no written row may carry weight ≤ 0",
  );
  // Plan ≡ write: the omitted ids ARE the classification.
  const omitted = rows
    .filter((row) => !writtenIds.has(row.card_id))
    .map((row) => row.card_id);
  const classified = computeCapDroppedCardIds(
    HEAVY_HITTERS.pool.map((c) => ({ cardId: c.cardId, value: c.value })),
    targets.maxWinCap,
  );
  assert(
    omitted.length === classified.length &&
      omitted.every((id, i) => id === classified[i]),
    `omitted [${omitted.join(", ")}] must equal classified [${classified.join(", ")}]`,
  );
  // Every retained card keeps a positive shaped weight (floor-at-1) — the
  // omission removes ONLY the cap-dropped card, count n−1.
  assert(
    written.length === HEAVY_HITTERS.pool.length - 1,
    `expected ${HEAVY_HITTERS.pool.length - 1} rows, got ${written.length}`,
  );
});

// ── 4. Pin on a cap-dropped card stays a refusal ────────────────────────

check("pins: pinning the cap-dropped Machamp is still the pins-infeasible + raise-cap refusal", () => {
  const targets = heavyHittersTargets();
  const search = searchBestPriceForCleanSnap(
    buildRetuneSearchParams("staged", {
      cards: HEAVY_HITTERS.pool.map((c) => ({
        value: c.value,
        cardId: c.cardId,
      })),
      basePrice: HEAVY_HITTERS.price,
      targetEdge: targets.targetEdge,
      targetWinRate: targets.targetWinRate,
      maxWinCap: targets.maxWinCap,
      nearMissMin: 0,
      winRateTol: 0.02,
      currentWeights: HEAVY_HITTERS.pool.map((c) => c.weight),
      intendedHitRate: targets.intendedHitRate,
      pinnedOdds: [{ cardId: "c-masaki-machamp", pct: 0.0005 }],
    }),
  );
  const r = search.bestResult;
  assert("error" in r, "a pin on a cap-dropped card must refuse, never drop silently");
  assert(r.limit.kind === "pins-infeasible", `kind ${r.limit.kind}`);
  assert(
    /raise the pack's max-win cap/i.test(r.limit.suggestion),
    `the raise-cap remedy must ride the refusal — got: ${r.limit.suggestion}`,
  );
});

// ── 5. No false positives (under-cap pool) ──────────────────────────────

check("under-cap pack: zero classifications and the write vector keeps every row", () => {
  // The pins.ts untagged anchored fixture — everything far under the cap.
  const pool = [
    { cardId: "u-dust", value: 0.35, weight: 880000 },
    { cardId: "u-near", value: 1.8, weight: 90000 },
    { cardId: "u-win", value: 4.2, weight: 29900 },
    { cardId: "u-grail", value: 120, weight: 100 },
  ];
  const classified = computeCapDroppedCardIds(
    pool.map((c) => ({ cardId: c.cardId, value: c.value })),
    250,
  );
  assert(classified.length === 0, `expected none, got [${classified.join(", ")}]`);
  const search = searchBestPriceForCleanSnap(
    buildRetuneSearchParams("live", {
      cards: pool.map((c) => ({ value: c.value, cardId: c.cardId })),
      basePrice: 2.5,
      targetEdge: 0.1105,
      targetWinRate: 0.2,
      maxWinCap: 250,
      nearMissMin: 0.1,
      winRateTol: 0.02,
      currentWeights: pool.map((c) => c.weight),
      intendedHitRate: null,
    }),
  );
  const r = search.bestResult;
  assert(!("error" in r), "under-cap fixture must solve");
  const written = omitZeroWeightRows(
    pool.map((c, i) => ({ card_id: c.cardId, weight: r.weights[i]! })),
  );
  assert(
    written.length === pool.length,
    `no row may be omitted on an under-cap pack (kept ${written.length}/${pool.length})`,
  );
});

// ── 6. Revert restores a removed card (catalog-based partition) ─────────

check("revert: a cap-removed card (absent from the live pool, in the catalog) IS restorable", () => {
  // The pre-push snapshot captured the full pool incl. the Machamp at its
  // live weight; after the push the live pool no longer contains it. The
  // partition must NOT consult the live pool — only the cards catalog.
  const snapshot = HEAVY_HITTERS.pool.map((c) => ({
    card_id: c.cardId,
    weight: c.weight,
  }));
  const catalog = new Set(HEAVY_HITTERS.pool.map((c) => c.cardId));
  const { restorable, skippedCardIds } = partitionSnapshotRestore(
    snapshot,
    catalog,
  );
  assert(
    restorable.some((c) => c.card_id === "c-masaki-machamp"),
    "the removed Machamp must be restored by a revert",
  );
  assert(restorable.length === snapshot.length, "every snapshot card restores");
  assert(skippedCardIds.length === 0, "nothing to skip");
});

check("revert: catalog-deleted cards and legacy weight-0 rows are skipped + reported", () => {
  const snapshot = [
    { card_id: "kept", weight: 30 },
    { card_id: "catalog-deleted", weight: 50 },
    { card_id: "legacy-zero", weight: 0 },
  ];
  const catalog = new Set(["kept", "legacy-zero"]);
  const { restorable, skippedCardIds } = partitionSnapshotRestore(
    snapshot,
    catalog,
  );
  assert(
    restorable.length === 1 && restorable[0]!.card_id === "kept",
    `expected only "kept", got [${restorable.map((c) => c.card_id).join(", ")}]`,
  );
  assert(
    skippedCardIds.length === 2 &&
      skippedCardIds.includes("catalog-deleted") &&
      skippedCardIds.includes("legacy-zero"),
    `expected both skips reported, got [${skippedCardIds.join(", ")}]`,
  );
});

// ── Summary ─────────────────────────────────────────────────────────────
console.log(
  `\n${passes} passed, ${failures.length} failed${
    failures.length > 0 ? ` — ${failures.join(", ")}` : ""
  }`,
);
if (failures.length > 0) process.exit(1);
