export const FINANCE_PERIODS = [
  { value: "24h", label: "24h", hours: 24 },
  { value: "3d", label: "3d", hours: 24 * 3 },
  { value: "7d", label: "7d", hours: 24 * 7 },
  { value: "14d", label: "14d", hours: 24 * 14 },
  { value: "30d", label: "30d", hours: 24 * 30 },
] as const;

export type FinancePeriod = (typeof FINANCE_PERIODS)[number]["value"];

export function parseFinancePeriod(value: string | undefined): FinancePeriod {
  return FINANCE_PERIODS.some((period) => period.value === value)
    ? (value as FinancePeriod)
    : "24h";
}

export function financePeriodLabel(period: FinancePeriod): string {
  return FINANCE_PERIODS.find((item) => item.value === period)?.label ?? "24h";
}
