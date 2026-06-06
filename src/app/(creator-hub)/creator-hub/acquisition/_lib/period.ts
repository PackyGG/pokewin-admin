import {
  parseDashboardPeriod,
  type DashboardPeriod,
} from "@/lib/queries/dashboard-period";
import type { FunnelPeriod } from "@/lib/queries/analytics-funnel";

/** Hub acquisition window — the compact chip set exposed on this page. */
export type AcquisitionHubPeriod = Extract<
  DashboardPeriod,
  "24h" | "7d" | "30d" | "all"
>;

/** Period accepted by `getAffiliateAnalytics` (admin /creators/analytics). */
export type AffiliateAnalyticsPeriod = "today" | "7d" | "30d" | "90d" | "all";

const ACQUISITION_HUB_PERIODS: AcquisitionHubPeriod[] = [
  "24h",
  "7d",
  "30d",
  "all",
];

export function parseAcquisitionHubPeriod(
  value: string | undefined | null,
): AcquisitionHubPeriod {
  const parsed = parseDashboardPeriod(value);
  if ((ACQUISITION_HUB_PERIODS as readonly string[]).includes(parsed)) {
    return parsed as AcquisitionHubPeriod;
  }
  return "30d";
}

/** Map Hub chip → affiliate analytics SQL window. */
export function hubPeriodToAffiliateAnalytics(
  period: AcquisitionHubPeriod,
): AffiliateAnalyticsPeriod {
  switch (period) {
    case "24h":
      return "today";
    case "7d":
      return "7d";
    case "30d":
      return "30d";
    case "all":
      return "all";
  }
}

/** Map Hub chip → platform acquisition funnel window. */
export function hubPeriodToFunnelPeriod(
  period: AcquisitionHubPeriod,
): FunnelPeriod {
  switch (period) {
    case "24h":
      return "7d";
    case "7d":
      return "7d";
    case "30d":
      return "30d";
    case "all":
      return "all";
  }
}
