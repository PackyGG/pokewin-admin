export type CreatorBattleOutcome = {
  stakeAmount: number;
  sponsorshipCost: number;
  payoutAmount: number | null;
  netAmount: number | null;
};

export type CreatorBattleOutcomeInput = {
  creatorWon: boolean | null;
  creatorPaidStake: number;
  creatorBorrowPercentage: number;
  sponsorshipAmountPaid: number;
  totalUnpacked: number | null;
  winningTeamSize: number;
};

function finiteNonNegativeOrNull(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Mirrors the battle settlement economics for the creator's seat.
 *
 * Winners receive an equal share of the total unpacked card value across all
 * members of the winning team (bots included). A borrowed seat owns only its
 * non-borrowed share. Sponsorship is a separate creator-paid cost covering the
 * other seats, so it belongs in the creator's all-in net result as well.
 */
export function calculateCreatorBattleOutcome(
  input: CreatorBattleOutcomeInput,
): CreatorBattleOutcome {
  const safeStake = finiteNonNegativeOrNull(input.creatorPaidStake) ?? 0;
  const safeSponsorship =
    finiteNonNegativeOrNull(input.sponsorshipAmountPaid) ?? 0;
  const safeBorrow = Number.isFinite(input.creatorBorrowPercentage)
    ? Math.min(100, Math.max(0, input.creatorBorrowPercentage))
    : 0;
  const borrowFactor =
    safeBorrow > 0
      ? 1 - safeBorrow / 100
      : 1;
  const stakeAmount = safeStake;
  const sponsorshipCost = safeSponsorship;

  if (input.creatorWon === null) {
    return {
      stakeAmount,
      sponsorshipCost,
      payoutAmount: null,
      netAmount: null,
    };
  }

  if (!input.creatorWon) {
    return {
      stakeAmount,
      sponsorshipCost,
      payoutAmount: 0,
      netAmount: -stakeAmount - sponsorshipCost,
    };
  }

  const safeTotalUnpacked =
    input.totalUnpacked === null
      ? null
      : finiteNonNegativeOrNull(input.totalUnpacked);
  const safeWinningTeamSize =
    Number.isInteger(input.winningTeamSize) && input.winningTeamSize > 0
      ? input.winningTeamSize
      : null;
  if (safeTotalUnpacked === null || safeWinningTeamSize === null) {
    return {
      stakeAmount,
      sponsorshipCost,
      payoutAmount: null,
      netAmount: null,
    };
  }

  const payoutAmount =
    (safeTotalUnpacked / safeWinningTeamSize) * borrowFactor;

  return {
    stakeAmount,
    sponsorshipCost,
    payoutAmount,
    netAmount: payoutAmount - stakeAmount - sponsorshipCost,
  };
}
