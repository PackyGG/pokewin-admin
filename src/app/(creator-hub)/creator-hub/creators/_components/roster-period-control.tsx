import { PeriodChips } from "@/components/ux";
import { type DashboardPeriod } from "@/lib/queries/dashboard-period";

import {
  ROSTER_PERIODS,
  ROSTER_DEFAULT_PERIOD,
} from "../_lib/roster-params";

/**
 * Creator Hub roster window selector — scopes the per-creator wager column +
 * the `wager_desc` sort to the chosen window. Thin wrapper over the canonical
 * URL-driven `PeriodChips` so the roster flips `?period=` with the same
 * "no scroll jump / no blank page" mechanics as the rest of the admin.
 *
 * Default = 7d (selecting it clears the param → bare canonical URL). Only the
 * active window is fetched per render (active-timeframe-only). Server-safe:
 * PeriodChips carries its own "use client" boundary and takes only data props.
 */

const ROSTER_PERIOD_LABELS: Record<DashboardPeriod, string> = {
  "1h": "1h",
  "3h": "3h",
  "6h": "6h",
  "12h": "12h",
  "24h": "24h",
  "48h": "48h",
  "3d": "3d",
  "7d": "7d",
  "30d": "30d",
  all: "All",
};

const ROSTER_PERIOD_ITEMS = ROSTER_PERIODS.map((value) => ({
  value,
  label: ROSTER_PERIOD_LABELS[value],
}));

export function RosterPeriodControl({ current }: { current: DashboardPeriod }) {
  return (
    <PeriodChips
      items={ROSTER_PERIOD_ITEMS}
      current={current}
      paramKey="period"
      defaultValue={ROSTER_DEFAULT_PERIOD}
      ariaNoun="window"
    />
  );
}
