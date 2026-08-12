export type RecurringDealWindow = {
  week_start_utc: string;
  week_end_utc: string;
  withdraw_cap_period_days?: 7 | 14 | null;
};

export type BackendDealPeriod<T extends RecurringDealWindow> = {
  index: number;
  count: number;
  payload: Omit<T, "withdraw_cap_period_days">;
};

/** Split one approved window into the independently enforced backend rows. */
export function buildBackendDealPeriods<T extends RecurringDealWindow>(
  payload: T,
): BackendDealPeriod<T>[] {
  const startMs = new Date(payload.week_start_utc).getTime();
  const endMs = new Date(payload.week_end_utc).getTime();
  const totalDays = (endMs - startMs) / 86_400_000;
  const periodDays = payload.withdraw_cap_period_days ?? totalDays;
  const count = totalDays / periodDays;
  const { withdraw_cap_period_days: _periodDays, ...backendTerms } = payload;

  if (
    !Number.isInteger(totalDays)
    || totalDays < 1
    || !Number.isInteger(count)
    || count < 1
  ) {
    throw new Error("Deal window must contain complete withdrawal-cap periods.");
  }

  return Array.from({ length: count }, (_, index) => ({
    index,
    count,
    payload: {
      ...backendTerms,
      week_start_utc: new Date(
        startMs + index * periodDays * 86_400_000,
      ).toISOString(),
      week_end_utc: new Date(
        startMs + (index + 1) * periodDays * 86_400_000,
      ).toISOString(),
    } as Omit<T, "withdraw_cap_period_days">,
  }));
}
