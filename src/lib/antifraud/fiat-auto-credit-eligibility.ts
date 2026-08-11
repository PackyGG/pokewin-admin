export const FIAT_AUTO_CREDIT_HISTORY_DAYS = 14;
export const FIAT_AUTO_CREDIT_MIN_CLEAN_DEPOSITS = 3;

export type FiatAutoCreditEligibilityFacts = {
  fiatAutoApprovalEnabled: boolean;
  cleanFiatDeposits: number;
  reversedFiatDeposits: number;
  firstCleanFiatAt: string | null;
  accountClean: boolean;
  fiatDepositsLocked: boolean;
  withdrawalsLocked: boolean;
};

export function isFiatAutoCreditEligible(
  user: FiatAutoCreditEligibilityFacts,
  now = Date.now(),
): boolean {
  const firstCleanAt = user.firstCleanFiatAt
    ? new Date(user.firstCleanFiatAt).getTime()
    : Number.NaN;
  return (
    !user.fiatAutoApprovalEnabled
    && user.accountClean
    && !user.fiatDepositsLocked
    && !user.withdrawalsLocked
    && user.cleanFiatDeposits >= FIAT_AUTO_CREDIT_MIN_CLEAN_DEPOSITS
    && user.reversedFiatDeposits === 0
    && Number.isFinite(firstCleanAt)
    && firstCleanAt
      <= now - FIAT_AUTO_CREDIT_HISTORY_DAYS * 24 * 60 * 60 * 1_000
  );
}
