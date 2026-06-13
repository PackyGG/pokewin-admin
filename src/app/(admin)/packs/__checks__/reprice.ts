/**
 * Global pack re-price — pure guard invariant checks.
 *
 * Run with:
 *   npx tsx "src/app/(admin)/packs/__checks__/reprice.ts"
 *
 * NO DB, NO React, NO server imports — imports ONLY the dep-free math module
 * (`insights/edge-calc/math`) and pins the safety invariants the owner set for
 * the "re-price every priced pack to 10.99%" tool:
 *
 *   1.  Band shape: hard ⊃ accept ∋ target (10.8 < 10.95 ≤ 10.99 ≤ 11.05 < 11.2).
 *   2.  Exact hit: a pack whose ideal price is a clean cent → action "reprice"
 *       at exactly 10.99%, inside the hard band.
 *   3.  Already-on-target → "unchanged" (no write), price unchanged.
 *   4.  The worked $0.45-EV case (rounds to ~11.76%) → "skip", newPrice null.
 *   5.  No pool (EV ≤ 0) → "skip", newPrice null.
 *   6.  repriceEdgeWithinHardBand boundaries (10.8% / 11.2% inclusive).
 *   7.  THE BIG ONE — sweep thousands of synthetic EVs: every "reprice" lands
 *       inside BOTH the accept band and the hard band with a positive price;
 *       every "skip" exposes NO writable price (newPrice === null). i.e. it is
 *       impossible for this tool to ever write an edge outside 10.8–11.2%.
 *
 * Exit code 0 = all passed; 1 = at least one failure (printed).
 */

import {
  planPackReprice,
  repriceEdgeWithinHardBand,
  REPRICE_TARGET_HOUSE_EDGE,
  REPRICE_ACCEPT_MIN_EDGE,
  REPRICE_ACCEPT_MAX_EDGE,
  REPRICE_HARD_MIN_EDGE,
  REPRICE_HARD_MAX_EDGE,
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
function poolForEv(ev: number, currentPrice: number) {
  return {
    currentPrice,
    cardsPerOpen: 1,
    totalWeight: 1,
    weightedPriceSum: ev,
  };
}

// ── 1. Band shape ───────────────────────────────────────────────────
check("band shape: hard ⊃ accept ∋ target", () => {
  assert(REPRICE_HARD_MIN_EDGE < REPRICE_ACCEPT_MIN_EDGE, "hard.min < accept.min");
  assert(REPRICE_ACCEPT_MIN_EDGE <= REPRICE_TARGET_HOUSE_EDGE, "accept.min ≤ target");
  assert(REPRICE_TARGET_HOUSE_EDGE <= REPRICE_ACCEPT_MAX_EDGE, "target ≤ accept.max");
  assert(REPRICE_ACCEPT_MAX_EDGE < REPRICE_HARD_MAX_EDGE, "accept.max < hard.max");
  approx(REPRICE_TARGET_HOUSE_EDGE, 0.1099, 1e-12, "target");
  approx(REPRICE_ACCEPT_MIN_EDGE, 0.1095, 1e-12, "accept.min");
  approx(REPRICE_ACCEPT_MAX_EDGE, 0.1105, 1e-12, "accept.max");
  approx(REPRICE_HARD_MIN_EDGE, 0.108, 1e-12, "hard.min");
  approx(REPRICE_HARD_MAX_EDGE, 0.112, 1e-12, "hard.max");
});

// ── 2. Exact hit at a clean cent ────────────────────────────────────
check("exact 10.99%: EV 8.901 with $10.00 ideal → reprice at $10.00, 10.99%", () => {
  // price = EV / 0.8901 = 8.901 / 0.8901 = 10.00 exactly → edge 10.99%.
  const plan = planPackReprice(poolForEv(8.901, 9.0));
  assert(plan.action === "reprice", `expected reprice, got ${plan.action}`);
  assert(plan.newPrice === 10, `expected newPrice 10.00, got ${plan.newPrice}`);
  approx(plan.newEdge ?? NaN, 0.1099, 1e-6, "newEdge");
  assert(repriceEdgeWithinHardBand(plan.newEdge ?? NaN), "newEdge in hard band");
});

// ── 3. Already on target → unchanged, no write ──────────────────────
check("already on target: EV 8.901 at $10.00 → unchanged", () => {
  const plan = planPackReprice(poolForEv(8.901, 10.0));
  assert(plan.action === "unchanged", `expected unchanged, got ${plan.action}`);
  assert(plan.newPrice === 10, "newPrice still 10.00");
});

// ── 4. Worked out-of-band case → skip, never writes ─────────────────
check("$0.45 EV (best cent ≈ 11.76%) → skip, newPrice null", () => {
  const plan = planPackReprice(poolForEv(0.45, 0.45));
  assert(plan.action === "skip", `expected skip, got ${plan.action}`);
  assert(plan.newPrice === null, `skip must not expose a price, got ${plan.newPrice}`);
  assert(/acceptance band/i.test(plan.reason), `reason should cite the band: "${plan.reason}"`);
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

// ── 6. Hard-band boundary helper ────────────────────────────────────
check("repriceEdgeWithinHardBand boundaries inclusive", () => {
  assert(!repriceEdgeWithinHardBand(0.1079), "10.79% rejected");
  assert(repriceEdgeWithinHardBand(0.108), "10.8% accepted (inclusive)");
  assert(repriceEdgeWithinHardBand(0.1099), "10.99% accepted");
  assert(repriceEdgeWithinHardBand(0.112), "11.2% accepted (inclusive)");
  assert(!repriceEdgeWithinHardBand(0.1121), "11.21% rejected");
  assert(!repriceEdgeWithinHardBand(NaN), "NaN rejected");
});

// ── 7. THE BIG ONE: exhaustive EV sweep, band can never be escaped ──
check("sweep: no reprice ever lands outside the band; skips never expose a price", () => {
  let repriced = 0;
  let unchanged = 0;
  let skipped = 0;
  // EV from $0.05 to $200 in 1-cent steps over a few cardsPerOpen shapes.
  for (const cardsPerOpen of [1, 3, 5]) {
    for (let cents = 5; cents <= 20000; cents++) {
      const ev = cents / 100;
      // Pool: cardsPerOpen identical cards so expectedCardValue × cpo = ev.
      const weightedPriceSum = ev; // expectedCardValue = ev / cardsPerOpen × cpo collapses below
      const plan = planPackReprice({
        currentPrice: ev, // arbitrary current price
        cardsPerOpen,
        totalWeight: cardsPerOpen,
        // expectedCardValue = weightedPriceSum/totalWeight = ev/cpo;
        // EV = (ev/cpo) × cpo = ev. So set weightedPriceSum = ev.
        weightedPriceSum,
      });

      if (plan.action === "reprice") {
        repriced++;
        assert(
          plan.newPrice !== null && plan.newPrice > 0,
          `reprice must have a positive price (ev=${ev}, cpo=${cardsPerOpen})`,
        );
        const edge = plan.newEdge ?? NaN;
        assert(
          edge >= REPRICE_ACCEPT_MIN_EDGE && edge <= REPRICE_ACCEPT_MAX_EDGE,
          `reprice edge ${edge} outside accept band (ev=${ev}, cpo=${cardsPerOpen})`,
        );
        assert(
          repriceEdgeWithinHardBand(edge),
          `reprice edge ${edge} outside HARD band (ev=${ev}, cpo=${cardsPerOpen})`,
        );
      } else if (plan.action === "unchanged") {
        unchanged++;
        const edge = plan.newEdge ?? NaN;
        assert(
          repriceEdgeWithinHardBand(edge),
          `unchanged edge ${edge} outside HARD band (ev=${ev}, cpo=${cardsPerOpen})`,
        );
      } else {
        skipped++;
        assert(
          plan.newPrice === null,
          `skip must not expose a writable price (ev=${ev}, cpo=${cardsPerOpen}, price=${plan.newPrice})`,
        );
      }
    }
  }
  console.log(
    `      swept ${repriced + unchanged + skipped} pools → ${repriced} reprice / ${unchanged} unchanged / ${skipped} skip`,
  );
  assert(repriced > 0, "sweep should produce at least some repriceable packs");
});

// ── Summary ─────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} re-price check(s) failed:`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log(`\n✓ All ${passes} pack re-price guard checks passed.`);
