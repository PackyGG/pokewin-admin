export const FTD_MAX_ACCOUNT_AGE_DAYS = 28;

const FTD_MAX_ACCOUNT_AGE_MS =
  FTD_MAX_ACCOUNT_AGE_DAYS * 24 * 60 * 60 * 1_000;

/**
 * FTD eligibility is frozen when the first completed deposit lands. Exactly
 * 28 days is allowed; impossible pre-signup deposit timestamps fail closed.
 */
export function isFtdAccountAgeEligible(
  accountCreatedAt: Date,
  firstDepositAt: Date,
): boolean {
  const accountAgeMs = firstDepositAt.getTime() - accountCreatedAt.getTime();
  return accountAgeMs >= 0 && accountAgeMs <= FTD_MAX_ACCOUNT_AGE_MS;
}
