import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateBuilderPricing,
  getBuilderOddsTotalUnits,
  hasExactBuilderOddsTotal,
  normalizeBuilderOdds,
} from "../../src/app/(pack-studio)/pack-studio/builder/builder-pricing";
import {
  clampPackBuilderEdge,
  isPackBuilderEdgeInRange,
  PACK_BUILDER_EDGE_MAX,
  PACK_BUILDER_EDGE_MIN,
} from "../../src/lib/packs/builder-edge";

test("Pack Builder accepts only edges from 10.95% through 12.00%", () => {
  assert.equal(isPackBuilderEdgeInRange(PACK_BUILDER_EDGE_MIN), true);
  assert.equal(isPackBuilderEdgeInRange(PACK_BUILDER_EDGE_MAX), true);
  assert.equal(isPackBuilderEdgeInRange(0.109499), false);
  assert.equal(isPackBuilderEdgeInRange(0.120001), false);
  assert.equal(clampPackBuilderEdge(0.01), PACK_BUILDER_EDGE_MIN);
  assert.equal(clampPackBuilderEdge(0.5), PACK_BUILDER_EDGE_MAX);
});

test("Pack Builder seeds a new pool with equal-weight EV", () => {
  const pricing = calculateBuilderPricing(
    [
      { priceUsd: 1, odds: 0 },
      { priceUsd: 9, odds: 0 },
    ],
    0.2,
  );

  assert.equal(pricing.expectedPayout, 5);
  assert.equal(pricing.suggestedPrice, 6.25);
});

test("Pack Builder prices from shaped odds at the selected edge", () => {
  const pricing = calculateBuilderPricing(
    [
      { priceUsd: 1, odds: 75 },
      { priceUsd: 9, odds: 25 },
    ],
    0.1,
  );

  assert.equal(pricing.expectedPayout, 3);
  assert.equal(pricing.suggestedPrice, 3.33);
});

test("Pack Builder ignores negative odds and rejects invalid edges", () => {
  const cards = [
    { priceUsd: 2, odds: -20 },
    { priceUsd: 6, odds: 100 },
  ];

  assert.deepEqual(calculateBuilderPricing(cards, 1), {
    expectedPayout: 0,
    suggestedPrice: 0,
  });
  assert.deepEqual(calculateBuilderPricing(cards, 0.25), {
    expectedPayout: 6,
    suggestedPrice: 8,
  });
});

test("Pack Builder normalizes displayed shaped odds to exactly 100.0000%", () => {
  const odds = normalizeBuilderOdds([
    33.3333333333,
    33.3333333333,
    33.3333333334,
  ]);

  assert.deepEqual(odds, [33.3334, 33.3333, 33.3333]);
  assert.equal(
    getBuilderOddsTotalUnits(odds.map((value) => ({ odds: value }))),
    1_000_000,
  );
  assert.equal(
    hasExactBuilderOddsTotal(odds.map((value) => ({ odds: value }))),
    true,
  );
});

test("Pack Builder refuses totals one four-decimal unit away from 100%", () => {
  assert.equal(
    hasExactBuilderOddsTotal([{ odds: 50 }, { odds: 49.9999 }]),
    false,
  );
  assert.equal(
    hasExactBuilderOddsTotal([{ odds: 50 }, { odds: 50.0001 }]),
    false,
  );
});
