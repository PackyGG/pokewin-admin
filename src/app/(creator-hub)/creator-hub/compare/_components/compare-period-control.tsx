import { PeriodChips } from "@/components/ux";
import { type DashboardPeriod } from "@/lib/queries/dashboard-period";

import {
  ROSTER_PERIODS,
  ROSTER_DEFAULT_PERIOD,
} from "../../creators/_lib/roster-params";

/**
 * Compare window selector — scopes windowed wager + GGR + ROI generated value.
 * Reuses the roster's compact period chip set.
 */

const PERIOD_LABELS: Record<DashboardPeriod, string> = {
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

const PERIOD_ITEMS = ROSTER_PERIODS.map((value) => ({
  value,
  label: PERIOD_LABELS[value],
}));

export function ComparePeriodControl({ current }: { current: DashboardPeriod }) {
  return (
    <PeriodChips
      items={PERIOD_ITEMS}
      current={current}
      paramKey="period"
      defaultValue={ROSTER_DEFAULT_PERIOD}
      ariaNoun="window"
    />
  );
}
