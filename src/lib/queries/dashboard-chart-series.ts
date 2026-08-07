import {
  periodToCutoff,
  type DashboardPeriod,
} from "./dashboard-period";

/** Dashboard trend charts use hour buckets for sub-day windows. */
export function dashboardChartHourlyBuckets(period: DashboardPeriod): boolean {
  return (
    period === "1h" ||
    period === "3h" ||
    period === "6h" ||
    period === "12h" ||
    period === "24h" ||
    period === "48h"
  );
}

/** Number of x-axis buckets to pad for the active period. */
function dashboardChartBucketCount(period: DashboardPeriod): number {
  switch (period) {
    case "1h":
      return 1;
    case "3h":
      return 3;
    case "6h":
      return 6;
    case "12h":
      return 12;
    case "24h":
      return 24;
    case "48h":
      return 48;
    case "3d":
      return 3;
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "all":
      return 365;
  }
}

/** SQL cutoff for chart scans — "all" is capped (same as headline GGR). */
export function dashboardChartCutoff(
  period: DashboardPeriod,
  now: Date,
  lifetimeLookbackDays: number,
): Date {
  if (period === "all") {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - lifetimeLookbackDays);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
  return periodToCutoff(period, now);
}

export function dashboardChartBucketExpr(
  col: string,
  period: DashboardPeriod,
): string {
  const unit = dashboardChartHourlyBuckets(period) ? "hour" : "day";
  return unit === "hour"
    ? `DATE_TRUNC('hour', ${col})`
    : `DATE(${col})`;
}

/** UTC label for one bucket — must match SQL bucket formatting. */
export function dashboardChartDateLabel(d: Date, period: DashboardPeriod): string {
  if (dashboardChartHourlyBuckets(period)) {
    return d.toISOString().slice(11, 16);
  }
  return d.toISOString().slice(0, 10);
}

function padSeries<T extends { date: string }>(
  rows: T[],
  period: DashboardPeriod,
  empty: Omit<T, "date">,
): T[] {
  const hourly = dashboardChartHourlyBuckets(period);
  const count = dashboardChartBucketCount(period);
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const now = new Date();
  const out: T[] = [];

  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now);
    if (hourly) {
      d.setUTCMinutes(0, 0, 0);
      d.setUTCHours(d.getUTCHours() - i);
    } else {
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() - i);
    }
    const date = dashboardChartDateLabel(d, period);
    out.push((byDate.get(date) as T | undefined) ?? ({ date, ...empty } as T));
  }

  return out;
}

export function padDashboardWagerSeries(
  rows: { date: string; packs: number; battles: number; upgrader: number }[],
  period: DashboardPeriod,
) {
  return padSeries(rows, period, { packs: 0, battles: 0, upgrader: 0 });
}

export function padDashboardDepositSeries(
  rows: { date: string; amount: number }[],
  period: DashboardPeriod,
) {
  return padSeries(rows, period, { amount: 0 });
}

export function padDashboardCountSeries(
  rows: { date: string; count: number }[],
  period: DashboardPeriod,
) {
  return padSeries(rows, period, { count: 0 });
}

export function padDashboardFtdSeries(
  rows: { date: string; count: number; total: number; avg: number }[],
  period: DashboardPeriod,
) {
  return padSeries(rows, period, { count: 0, total: 0, avg: 0 });
}

export function padDashboardAttributionSeries(
  rows: { date: string; organic: number; creatorCoded: number }[],
  period: DashboardPeriod,
) {
  return padSeries(rows, period, { organic: 0, creatorCoded: 0 });
}
