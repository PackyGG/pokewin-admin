import "server-only";

import { type DashboardPeriod } from "@/lib/queries/dashboard-period";
import {
  hubBucketByHour,
  HUB_LIFETIME_LOOKBACK_DAYS,
} from "./hub-period-sql";
import { type HubChartPoint } from "./hub-types";

/** UTC label for one bucket — must match `formatBucketLabel` in cohort SQL. */
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
