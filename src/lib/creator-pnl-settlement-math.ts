export type FramePnlLegs = {
  affiliateContributionUsd: number;
  weightedCreatorGameplayPnlUsd: number;
  leaderboardHouseCostUsd: number;
  fillCashoutCostUsd: number;
  tipCostUsd: number;
  sponsorshipCostUsd: number;
  rewardProgramCostUsd: number;
};

export function roundSettlementMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function calculateFrameSitePnlUsd(legs: FramePnlLegs): number {
  return roundSettlementMoney(
    legs.affiliateContributionUsd + legs.weightedCreatorGameplayPnlUsd
      - legs.leaderboardHouseCostUsd - legs.fillCashoutCostUsd
      - legs.tipCostUsd - legs.sponsorshipCostUsd - legs.rewardProgramCostUsd,
  );
}
