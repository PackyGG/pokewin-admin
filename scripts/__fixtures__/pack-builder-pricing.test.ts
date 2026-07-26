import assert from "node:assert/strict";
import test from "node:test";

import { calculateBuilderPricing } from "../../src/app/(pack-studio)/pack-studio/builder/builder-pricing";

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
