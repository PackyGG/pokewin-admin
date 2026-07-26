import {
  computePackEv,
  suggestedPriceFromEv,
} from "@/app/(admin)/insights/edge-calc/math";

export type BuilderPricingCard = {
  priceUsd: number;
  odds: number;
};

export type BuilderPricing = {
  expectedPayout: number;
  suggestedPrice: number;
};

/**
 * Derive a Pack Builder sticker price from the current pool EV and target edge.
 * A brand-new pool has no shaped odds yet, so it starts with equal weights.
 * Once odds exist, their exact normalized EV becomes authoritative.
 */
export function calculateBuilderPricing(
  cards: BuilderPricingCard[],
  targetEdge: number,
): BuilderPricing {
  if (cards.length === 0 || !(targetEdge > 0 && targetEdge < 1)) {
    return { expectedPayout: 0, suggestedPrice: 0 };
  }

  const totalOdds = cards.reduce(
    (sum, card) => sum + Math.max(0, card.odds),
    0,
  );
  const useEqualWeights = !(totalOdds > 0);
  const totalWeight = useEqualWeights ? cards.length : totalOdds;
  const weightedPriceSum = cards.reduce(
    (sum, card) =>
      sum + card.priceUsd * (useEqualWeights ? 1 : Math.max(0, card.odds)),
    0,
  );
  const expectedPayout = computePackEv({
    pricePerOpen: 0,
    cardsPerOpen: 1,
    totalWeight,
    weightedPriceSum,
  }).expectedPayoutPerOpen;

  return {
    expectedPayout,
    suggestedPrice: suggestedPriceFromEv(expectedPayout, targetEdge),
  };
}
