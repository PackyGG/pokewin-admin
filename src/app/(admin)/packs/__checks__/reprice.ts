/**
 * Global pack re-price — pure guard invariant checks.
 *
 * Run with:
 *   npx tsx "src/app/(admin)/packs/__checks__/reprice.ts"
 *
 * NO DB, NO React, NO server imports — imports ONLY the dep-free math module
 * (`insights/edge-calc/math`) and pins the safety invariants for the
 * "re-price active official packs → target edge" tool (target is owner-custom,
 * default 10.99%; bands are RELATIVE to the chosen target):
 *
 *   1.  Band shape: hard ⊃ accept ∋ target; target range 1%–50%.
 *   2.  Exact hit at the default 10.99% target → "reprice" at the clean cent.
 *   3.  Already-on-target → "unchanged" (no write).
 *   4.  The REAL "1% 18 PLUS" case ($1.25, 1 card, EV $1.1153 → 10.78%) →
 *       "skip" at the 10.99% target, newPrice null (no cent hits the band).
 *   5.  No pool (EV ≤ 0) → "skip", newPrice null.
 *   6.  repriceEdgeWithinHardBand is relative to the target (default + custom).
 *   7.  Custom target (15%) hits a clean cent → "reprice" at 15%.
 *   8.  clampRepriceTarget bounds the target into [1%, 50%].
 *   9.  THE BIG ONE — sweep thousands of synthetic EVs at multiple targets:
 *       every "reprice" lands within ±ACCEPT of the target AND inside the hard
 *       band; every "skip" exposes NO writable price (newPrice === null).
 *
 * Exit code 0 = all passed; 1 = at least one failure (printed).
 */

import {
  planPackReprice,
  repriceEdgeWithinHardBand,
  clampRepriceTarget,
  REPRICE_TARGET_DEFAULT,
  REPRICE_TARGET_MIN,
  REPRICE_TARGET_MAX,
  REPRICE_ACCEPT_TOLERANCE,
  REPRICE_HARD_TOLERANCE,
} from "../../insights/edge-calc/math";

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

function approx(actual: number, expected: number, eps: number, what: string): void {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > eps) {
    throw new Error(`${what}: expected ≈${expected} (±${eps}), got ${actual}`);
  }
}

/** A single-card pool whose EV per open equals `ev` exactly (weight 1). */
function poolForEv(ev: number, currentPrice: number, targetEdge?: number) {
  return {
    currentPrice,
    cardsPerOpen: 1,
    totalWeight: 1,
    weightedPriceSum: ev,
    targetEdge,
  };
}

// ── 1. Band shape ───────────────────────────────────────────────────
check("band shape: accept ⊂ hard, sane tolerances + target range", () => {
  assert(REPRICE_ACCEPT_TOLERANCE > 0, "accept tol > 0");
  assert(REPRICE_HARD_TOLERANCE > REPRICE_ACCEPT_TOLERANCE, "hard tol > accept tol");
  approx(REPRICE_TARGET_DEFAULT, 0.1099, 1e-12, "default target");
  approx(REPRICE_TARGET_MIN, 0.01, 1e-12, "min target");
  approx(REPRICE_TARGET_MAX, 0.5, 1e-12, "max target");
});

// ── 2. Exact hit at the default target ──────────────────────────────
check("exact 10.99%: EV 8.901 with $10.00 ideal → reprice at $10.00", () => {
  const plan = planPackReprice(poolForEv(8.901, 9.0));
  assert(plan.action === "reprice", `expected reprice, got ${plan.action}`);
  assert(plan.newPrice === 10, `expected $10.00, got ${plan.newPrice}`);
  approx(plan.newEdge ?? NaN, 0.1099, 1e-6, "newEdge");
  assert(repriceEdgeWithinHardBand(plan.newEdge ?? NaN), "in hard band");
});

// ── 3. Already on target → unchanged ────────────────────────────────
check("already on target: EV 8.901 at $10.00 → unchanged", () => {
  const plan = planPackReprice(poolForEv(8.901, 10.0));
  assert(plan.action === "unchanged", `expected unchanged, got ${plan.action}`);
});

// ── 4. The REAL "1% 18 PLUS" pack ───────────────────────────────────
check("'1% 18 PLUS' ($1.25, EV $1.1153) → skip at 10.99%, newPrice null", () => {
  // Verified read-only against prod: price $1.25, cpo 1, EV $1.1153.
  // $1.25→10.78%, $1.26→11.48% — no whole cent lands in the band.
  const plan = planPackReprice(poolForEv(1.1153, 1.25));
  assert(plan.action === "skip", `expected skip, got ${plan.action}`);
  assert(plan.newPrice === null, `skip must not expose a price, got ${plan.newPrice}`);
  approx(plan.currentEdge, 0.10776, 5e-4, "currentEdge ~10.78%");
  assert(/10\.78%|11\.48%/.test(plan.reason), `reason should bracket the cents: "${plan.reason}"`);
});

// ── 5. No priceable pool → skip ─────────────────────────────────────
check("no pool (totalWeight 0) → skip, newPrice null", () => {
  const plan = planPackReprice({
    currentPrice: 5,
    cardsPerOpen: 5,
    totalWeight: 0,
    weightedPriceSum: 0,
  });
  assert(plan.action === "skip", `expected skip, got ${plan.action}`);
  assert(plan.newPrice === null, "newPrice null");
});

// ── 6. Hard-band helper is relative to the target ───────────────────
check("repriceEdgeWithinHardBand relative to target", () => {
  // default target 10.99%, hard tol 0.002 → ~[10.79%, 11.19%]. (Values are
  // kept clearly inside/outside the boundary so IEEE float fuzz at the exact
  // edge — which the guard correctly treats as fail-closed — can't flake.)
  assert(!repriceEdgeWithinHardBand(0.1078), "10.78% rejected (default)");
  assert(repriceEdgeWithinHardBand(0.1099), "10.99% accepted (default)");
  assert(repriceEdgeWithinHardBand(0.1117), "11.17% accepted (default)");
  assert(!repriceEdgeWithinHardBand(0.1121), "11.21% rejected (default)");
  // custom target 15% → ~[14.8%, 15.2%]
  assert(repriceEdgeWithinHardBand(0.15, 0.15), "15% accepted (custom)");
  assert(repriceEdgeWithinHardBand(0.1482, 0.15), "14.82% accepted (custom)");
  assert(!repriceEdgeWithinHardBand(0.146, 0.15), "14.6% rejected (custom)");
  assert(!repriceEdgeWithinHardBand(0.1099, 0.15), "10.99% rejected at 15% target");
});

// ── 7. Custom target (15%) ──────────────────────────────────────────
check("custom 15% target: EV 8.5 → reprice at $10.00 (15% edge)", () => {
  // price = EV / (1 - 0.15) = 8.5 / 0.85 = $10.00 exactly → edge 15%.
  const plan = planPackReprice(poolForEv(8.5, 9.0, 0.15));
  assert(plan.action === "reprice", `expected reprice, got ${plan.action}`);
  assert(plan.newPrice === 10, `expected $10.00, got ${plan.newPrice}`);
  approx(plan.newEdge ?? NaN, 0.15, 1e-6, "newEdge ~15%");
  assert(repriceEdgeWithinHardBand(plan.newEdge ?? NaN, 0.15), "in hard band of 15%");
});

// ── 8. clampRepriceTarget bounds ────────────────────────────────────
check("clampRepriceTarget bounds [1%, 50%]; NaN → default", () => {
  assert(clampRepriceTarget(0.6) === REPRICE_TARGET_MAX, "0.6 → 0.5");
  assert(clampRepriceTarget(0.001) === REPRICE_TARGET_MIN, "0.001 → 0.01");
  assert(clampRepriceTarget(0.15) === 0.15, "0.15 passes through");
  assert(clampRepriceTarget(NaN) === REPRICE_TARGET_DEFAULT, "NaN → default");
});

// ── 9. THE BIG ONE: exhaustive sweep at multiple targets ────────────
check("sweep: reprice always in band; skips never expose a price", () => {
  let repriced = 0;
  let skipped = 0;
  let unchanged = 0;
  for (const target of [0.1099, 0.15, 0.05, 0.2]) {
    for (const cardsPerOpen of [1, 5]) {
      for (let cents = 5; cents <= 20000; cents++) {
        const ev = cents / 100;
        const plan = planPackReprice({
          currentPrice: ev,
          cardsPerOpen,
          totalWeight: cardsPerOpen,
          weightedPriceSum: ev, // expectedCardValue = ev/cpo → EV = ev
          targetEdge: target,
        });
        if (plan.action === "reprice") {
          repriced++;
          const edge = plan.newEdge ?? NaN;
          assert(
            plan.newPrice !== null && plan.newPrice > 0,
            `reprice needs a positive price (ev=${ev}, t=${target})`,
          );
          assert(
            Math.abs(edge - target) <= REPRICE_ACCEPT_TOLERANCE,
            `reprice edge ${edge} outside accept of ${target} (ev=${ev})`,
          );
          assert(
            repriceEdgeWithinHardBand(edge, target),
            `reprice edge ${edge} outside HARD band of ${target} (ev=${ev})`,
          );
        } else if (plan.action === "unchanged") {
          unchanged++;
        } else {
          skipped++;
          assert(
            plan.newPrice === null,
            `skip must not expose a price (ev=${ev}, t=${target})`,
          );
        }
      }
    }
  }
  console.log(
    `      swept ${repriced + unchanged + skipped} pools → ${repriced} reprice / ${unchanged} unchanged / ${skipped} skip`,
  );
  assert(repriced > 0, "sweep should produce repriceable packs");
});

// ── 10. ROUND-UP MODE: never below target, never overcharge ─────────
check("round-up: edge always ≥ target, 'up' price ≥ 'nearest', overshoot→skip", () => {
  let upRepriced = 0;
  let upSkipped = 0;
  let upUnchanged = 0;
  for (const target of [0.1099, 0.15, 0.05, 0.2]) {
    for (const cardsPerOpen of [1, 5]) {
      for (let cents = 5; cents <= 20000; cents++) {
        const ev = cents / 100;
        const pool = {
          currentPrice: ev,
          cardsPerOpen,
          totalWeight: cardsPerOpen,
          weightedPriceSum: ev, // expectedCardValue = ev/cpo → EV = ev
          targetEdge: target,
        };
        const up = planPackReprice({ ...pool, roundingMode: "up" });
        const near = planPackReprice({ ...pool, roundingMode: "nearest" });

        if (up.action === "reprice" || up.action === "unchanged") {
          if (up.action === "reprice") upRepriced++;
          else upUnchanged++;
          const edge = up.newEdge ?? NaN;
          assert(
            up.newPrice !== null && up.newPrice > 0,
            `up needs a positive price (ev=${ev}, t=${target})`,
          );
          // NEVER below target (the whole point of round-up): edge ≥ target,
          // allowing a tiny ACCEPT-sized float slack on the low side only.
          assert(
            edge >= target - REPRICE_ACCEPT_TOLERANCE,
            `up edge ${edge} below target ${target} (ev=${ev})`,
          );
          // Still inside the accept band (never overshoot a written price).
          assert(
            Math.abs(edge - target) <= REPRICE_ACCEPT_TOLERANCE,
            `up edge ${edge} outside accept of ${target} (ev=${ev})`,
          );
          assert(
            repriceEdgeWithinHardBand(edge, target),
            `up edge ${edge} outside HARD band of ${target} (ev=${ev})`,
          );
        } else {
          upSkipped++;
          assert(
            up.newPrice === null,
            `up skip must not expose a price (ev=${ev}, t=${target})`,
          );
        }

        // 'up' price is always ≥ 'nearest' price when both produce a price
        // (round-up never picks a cheaper cent than round-to-nearest).
        const upPrice = up.newPrice;
        const nearPrice = near.newPrice;
        if (upPrice !== null && nearPrice !== null) {
          assert(
            Math.round(upPrice * 100) >= Math.round(nearPrice * 100),
            `up price ${upPrice} < nearest price ${nearPrice} (ev=${ev}, t=${target})`,
          );
        }
      }
    }
  }
  console.log(
    `      up-swept pools → ${upRepriced} reprice / ${upUnchanged} unchanged / ${upSkipped} skip`,
  );
  assert(upRepriced > 0, "round-up sweep should produce repriceable packs");
  assert(upSkipped > 0, "round-up sweep should produce skips (overshoot cases)");
});

// ── 11. ROUND-UP defaults to legacy 'nearest' when mode omitted ──────
check("round-up: omitting roundingMode === explicit 'nearest' (legacy untouched)", () => {
  for (const ev of [8.901, 1.1153, 8.5, 0.5, 123.45]) {
    const a = planPackReprice(poolForEv(ev, ev));
    const b = planPackReprice({ ...poolForEv(ev, ev), roundingMode: "nearest" });
    assert(a.action === b.action, `action mismatch at ev=${ev}: ${a.action} vs ${b.action}`);
    assert(a.newPrice === b.newPrice, `newPrice mismatch at ev=${ev}`);
  }
});

// ── 12. ROUND-UP concrete overshoot → skip (the '1% 18 PLUS' shape) ──
check("round-up: $1.25/EV $1.1153 → skip (ceil cent $1.26→11.48% overshoots)", () => {
  // ideal = 1.1153/0.8901 = $1.2530 → ceil = $1.26 → 11.48%, which overshoots
  // the 10.99% target beyond ±0.05% → round-up must skip, not overcharge.
  const plan = planPackReprice({ ...poolForEv(1.1153, 1.25), roundingMode: "up" });
  assert(plan.action === "skip", `expected skip, got ${plan.action}`);
  assert(plan.newPrice === null, `skip must not expose a price, got ${plan.newPrice}`);
});

// ── 13. WRITE-PATH WIRING: re-pin/reprice write is one-sided-up ─────
// The authoritative write (`repricePackToTargetEdge`) and BOTH dry-runs
// (`planRepriceAllPacks`, `planCustomRepin`) now call `planPackReprice` with
// `roundingMode: "up"`. This check pins the END-TO-END invariant that wiring
// guarantees: for the exact shape those call sites pass — a per-pack target
// (the curve target lands anywhere in [10.99%, 11.50%]) plus a fresh pool — a
// "reprice"/"unchanged" result NEVER lands the edge BELOW target. A "skip"
// exposes no price. This is stricter than §10's ACCEPT-slack lower bound: a
// WRITTEN edge must be ≥ target up to a tight float epsilon, i.e. truly never
// under the floor.
check("write-path: round-up reprice/unchanged edge ≥ target (never below), per-pack targets", () => {
  // Float epsilon only — NOT the ACCEPT tolerance. A written price's edge must be
  // at or above target; the only slack permitted is IEEE rounding noise.
  const EPS = 1e-9;
  let written = 0;
  let skipped = 0;
  // Sweep per-pack-shaped targets across the full curve band [10.99%, 11.50%]
  // (what `autoTargetEdge` can emit) plus the flat-tool extremes, against a wide
  // EV grid and both cards-per-open the real pools use.
  for (const target of [0.1099, 0.111, 0.1125, 0.114, 0.115, 0.05, 0.2, 0.5]) {
    for (const cardsPerOpen of [1, 5]) {
      for (let cents = 5; cents <= 20000; cents++) {
        const ev = cents / 100;
        const plan = planPackReprice({
          currentPrice: ev,
          cardsPerOpen,
          totalWeight: cardsPerOpen,
          weightedPriceSum: ev,
          targetEdge: target,
          roundingMode: "up",
        });
        if (plan.action === "reprice" || plan.action === "unchanged") {
          written++;
          const edge = plan.newEdge ?? NaN;
          assert(
            plan.newPrice !== null && plan.newPrice > 0,
            `written needs a positive price (ev=${ev}, t=${target})`,
          );
          // THE FLOOR: a written edge is NEVER below target (float-eps only).
          assert(
            edge >= target - EPS,
            `WRITE FLOOR VIOLATED: edge ${edge} < target ${target} (ev=${ev}, cpo=${cardsPerOpen})`,
          );
          // And still inside the accept band on the high side (never overcharge).
          assert(
            edge - target <= REPRICE_ACCEPT_TOLERANCE,
            `written edge ${edge} overshoots accept of ${target} (ev=${ev})`,
          );
          assert(
            repriceEdgeWithinHardBand(edge, target),
            `written edge ${edge} outside HARD band of ${target} (ev=${ev})`,
          );
        } else {
          skipped++;
          assert(
            plan.newPrice === null,
            `skip must not expose a price (ev=${ev}, t=${target})`,
          );
        }
      }
    }
  }
  console.log(
    `      write-path swept → ${written} written (edge ≥ target) / ${skipped} skip`,
  );
  assert(written > 0, "write-path sweep should produce written packs");
  assert(skipped > 0, "write-path sweep should produce skips (overshoot cases)");
});

// ── Summary ─────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} re-price check(s) failed:`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log(`\n✓ All ${passes} pack re-price guard checks passed.`);
