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

const ODDS_UNITS_PER_PERCENT = 10_000;
export const EXACT_ODDS_TOTAL_UNITS = 100 * ODDS_UNITS_PER_PERCENT;

export function oddsPercentToUnits(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.max(0, value) * ODDS_UNITS_PER_PERCENT);
}

export function getBuilderOddsTotalUnits(
  cards: Pick<BuilderPricingCard, "odds">[],
): number {
  return cards.reduce(
    (total, card) => total + oddsPercentToUnits(card.odds),
    0,
  );
}

export function hasExactBuilderOddsTotal(
  cards: Pick<BuilderPricingCard, "odds">[],
): boolean {
  return getBuilderOddsTotalUnits(cards) === EXACT_ODDS_TOTAL_UNITS;
}

/**
 * Round shaped percentages to the builder's four-decimal precision while
 * keeping their displayed sum exactly 100.0000%.
 */
export function normalizeBuilderOdds(values: number[]): number[] {
  if (values.length === 0) return [];

  const units = values.map(oddsPercentToUnits);
  const largestIndex = units.reduce(
    (bestIndex, value, index) =>
      value > units[bestIndex]! ? index : bestIndex,
    0,
  );
  units[largestIndex] +=
    EXACT_ODDS_TOTAL_UNITS - units.reduce((sum, value) => sum + value, 0);

  return units.map((value) => value / ODDS_UNITS_PER_PERCENT);
}

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
