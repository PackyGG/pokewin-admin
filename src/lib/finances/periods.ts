export const FINANCE_PERIODS = [
  { value: "7d", label: "Week", hours: 24 * 7 },
  { value: "14d", label: "14d", hours: 24 * 14 },
  { value: "30d", label: "30d", hours: 24 * 30 },
] as const;

export type FinancePeriod = (typeof FINANCE_PERIODS)[number]["value"];

export function parseFinancePeriod(value: string | undefined): FinancePeriod {
  return FINANCE_PERIODS.some((period) => period.value === value)
    ? (value as FinancePeriod)
    : "7d";
}

export function financePeriodLabel(period: FinancePeriod): string {
  return FINANCE_PERIODS.find((item) => item.value === period)?.label ?? "Week";
}

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

export function financeWeekBounds(now: Date = new Date()): {
  start: Date;
  endExclusive: Date;
} {
  const utcDay = now.getUTCDay();
  const daysSinceMonday = (utcDay + 6) % 7;
  const start = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - daysSinceMonday,
    ),
  );

  return {
    start,
    endExclusive: new Date(start.getTime() + 7 * DAY_MS),
  };
}

/**
 * The 7d finance chip represents the current accounting week rather than a
 * rolling 168-hour window. All other chips intentionally remain rolling.
 */
export function financePeriodSince(
  period: FinancePeriod,
  now: Date = new Date(),
): Date {
  if (period === "7d") return financeWeekBounds(now).start;

  const definition = FINANCE_PERIODS.find((item) => item.value === period);
  const hours = definition?.hours ?? 24 * 7;
  return new Date(now.getTime() - hours * HOUR_MS);
}

export function financeWeekDateRange(now: Date = new Date()): string {
  const { start, endExclusive } = financeWeekBounds(now);
  const end = new Date(endExclusive.getTime() - DAY_MS);
  const formatter = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

  return `${formatter.format(start)} – ${formatter.format(end)}`;
}
