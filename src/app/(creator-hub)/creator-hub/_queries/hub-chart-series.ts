import "server-only";

import { type DashboardPeriod } from "@/lib/queries/dashboard-period";
import {
  hubBucketByHour,
  HUB_LIFETIME_LOOKBACK_DAYS,
} from "./hub-period-sql";
import {
  type HubChartPoint,
  type HubDepositChartRow,
  type HubSignupsFtdsChartRow,
  type HubWagerChartRow,
} from "./hub-types";
import { HUB_CHART_PERIOD } from "./hub-period-sql";

/** UTC label for one bucket — must match cohort SQL `formatBucketLabel`. */
export function chartDateForBucket(d: Date, period: DashboardPeriod): string {
  if (hubBucketByHour(period)) {
    return d.toISOString().slice(11, 16);
  }
  return d.toISOString().slice(0, 10);
}

function bucketLabel(d: Date, hourly: boolean): string {
  if (hourly) return d.toISOString().slice(11, 16);
  return d.toISOString().slice(5, 10);
}

function bucketCount(period: DashboardPeriod): number {
  if (hubBucketByHour(period)) return 24;
  switch (period) {
    case "1h":
    case "3h":
    case "6h":
    case "12h":
      return 1;
    case "48h":
      return 2;
    case "3d":
      return 3;
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "all":
      return HUB_LIFETIME_LOOKBACK_DAYS;
    case "24h":
      return 24;
  }
}

/**
 * Fill missing buckets with zero so recharts draws a continuous window
 * (hourly for 24h, daily for longer chips) instead of sparse dots.
 */
export function padHubChartSeries(
  points: HubChartPoint[],
  period: DashboardPeriod,
): HubChartPoint[] {
  const hourly = hubBucketByHour(period);
  const count = bucketCount(period);
  const byLabel = new Map(points.map((p) => [p.label, p.value]));

  const now = new Date();
  const labels: string[] = [];

  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now);
    if (hourly) {
      d.setUTCMinutes(0, 0, 0);
      d.setUTCHours(d.getUTCHours() - i);
    } else {
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() - i);
    }
    labels.push(bucketLabel(d, hourly));
  }

  return labels.map((label) => ({
    label,
    value: byLabel.get(label) ?? 0,
  }));
}

export function padHubWagerChartSeries(
  rows: HubWagerChartRow[],
  period: DashboardPeriod,
): HubWagerChartRow[] {
  const hourly = hubBucketByHour(period);
  const count = bucketCount(period);
  const byDate = new Map(rows.map((r) => [r.date, r]));

  const now = new Date();
  const out: HubWagerChartRow[] = [];

  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now);
    if (hourly) {
      d.setUTCMinutes(0, 0, 0);
      d.setUTCHours(d.getUTCHours() - i);
    } else {
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() - i);
    }
    const date = chartDateForBucket(d, period);
    const prev = byDate.get(date);
    out.push(
      prev ?? { date, packs: 0, battles: 0, upgrader: 0 },
    );
  }

  return out;
}

export function padHubDepositChartSeries(
  rows: HubDepositChartRow[],
  period: DashboardPeriod,
): HubDepositChartRow[] {
  const hourly = hubBucketByHour(period);
  const count = bucketCount(period);
  const byDate = new Map(rows.map((r) => [r.date, r.amount]));

  const now = new Date();
  const out: HubDepositChartRow[] = [];

  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now);
    if (hourly) {
      d.setUTCMinutes(0, 0, 0);
      d.setUTCHours(d.getUTCHours() - i);
    } else {
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() - i);
    }
    const date = chartDateForBucket(d, period);
    out.push({ date, amount: byDate.get(date) ?? 0 });
  }

  return out;
}

export function padHubSignupsFtdsChartSeries(
  rows: HubSignupsFtdsChartRow[],
  period: DashboardPeriod = HUB_CHART_PERIOD,
): HubSignupsFtdsChartRow[] {
  const hourly = hubBucketByHour(period);
  const count = bucketCount(period);
  const byDate = new Map(rows.map((r) => [r.date, r]));

  const now = new Date();
  const out: HubSignupsFtdsChartRow[] = [];

  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now);
    if (hourly) {
      d.setUTCMinutes(0, 0, 0);
      d.setUTCHours(d.getUTCHours() - i);
    } else {
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() - i);
    }
    const date = chartDateForBucket(d, period);
    const prev = byDate.get(date);
    out.push(
      prev ?? { date, signups: 0, ftds: 0 },
    );
  }

  return out;
}

/** Human title suffix for hub chart cards (matches period chip). */
export function hubChartTitleSuffix(period: DashboardPeriod): string {
  if (hubBucketByHour(period)) return `${period} (hourly)`;
  if (period === "all") return "365d";
  return period;
}
