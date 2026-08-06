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
  const borrowFactor =
    input.creatorBorrowPercentage > 0
      ? 1 - input.creatorBorrowPercentage / 100
      : 1;
  const stakeAmount = input.creatorPaidStake;
  const sponsorshipCost = input.sponsorshipAmountPaid;

  if (input.creatorWon === null) {
    return {
      stakeAmount,
      sponsorshipCost,
      payoutAmount: null,
      netAmount: null,
    };
  }

  const payoutAmount =
    input.creatorWon &&
    input.totalUnpacked !== null &&
    input.winningTeamSize > 0
      ? (input.totalUnpacked / input.winningTeamSize) * borrowFactor
      : 0;

  return {
    stakeAmount,
    sponsorshipCost,
    payoutAmount,
    netAmount: payoutAmount - stakeAmount - sponsorshipCost,
  };
}
