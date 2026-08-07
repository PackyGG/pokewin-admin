export type RewardContinuityTerms = {
  codes: readonly string[] | null;
  thresholdUsd: unknown;
  rewardUsd: unknown;
  vipRewardUsd: unknown;
  lossbackPct: unknown;
  minDepositUsd: unknown;
  maxRewardPerUserUsd: unknown;
};

function canonicalCodes(codes: readonly string[] | null): string[] {
  return [...new Set((codes ?? []).map((code) => code.trim().toUpperCase()))].sort();
}

function sameNullableNumber(left: unknown, right: unknown): boolean {
  if (left == null || right == null) return left == null && right == null;
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  return Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber === rightNumber;
}

/**
 * Old wager basis can stay on one program only when its attribution set and
 * payout economics remain identical. Names and dates deliberately do not
 * participate: they do not change qualification or consumption.
 */
export function rewardProgramsCanContinue(
  stored: RewardContinuityTerms,
  next: RewardContinuityTerms,
): boolean {
  return JSON.stringify(canonicalCodes(stored.codes)) === JSON.stringify(canonicalCodes(next.codes))
    && sameNullableNumber(stored.thresholdUsd, next.thresholdUsd)
    && sameNullableNumber(stored.rewardUsd, next.rewardUsd)
    && sameNullableNumber(stored.vipRewardUsd, next.vipRewardUsd)
    && sameNullableNumber(stored.lossbackPct, next.lossbackPct)
    && sameNullableNumber(stored.minDepositUsd, next.minDepositUsd)
    && sameNullableNumber(stored.maxRewardPerUserUsd, next.maxRewardPerUserUsd);
}

function isExactRewardBoundary(priorEndsAt: Date | string, nextStartsAt: Date | string): boolean {
  const prior = new Date(priorEndsAt).getTime();
  const next = new Date(nextStartsAt).getTime();
  return Number.isFinite(prior) && prior === next;
}
