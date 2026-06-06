import { PeriodChips } from "@/components/ux";
import { type DashboardPeriod } from "@/lib/queries/dashboard-period";

/**
 * Creator Hub → Acquisition timespan selector.
 *
 * Thin wrapper over the canonical URL-driven `PeriodChips`, matching the
 * Hub dashboard / changelog selectors so the whole Hub uses one consistent
 * window set + the same "flip ?period= without losing scroll" mechanics.
 *
 * Set = 24h / 7d / 30d / all. Default = 24h; selecting 24h clears the
 * param so the canonical acquisition URL is bare.
 *
 * Active-timeframe-only: only the active window's analytics are fetched per
 * render (the page wraps the data section in `<Suspense key={period}>`).
 */

const HUB_ACQUISITION_PERIOD_ITEMS: { value: DashboardPeriod; label: string }[] =
  [
    { value: "24h", label: "24h" },
    { value: "7d", label: "7d" },
    { value: "30d", label: "30d" },
    { value: "all", label: "All" },
  ];

export function HubAcquisitionPeriodSelector({
  current,
}: {
  current: DashboardPeriod;
}) {
  return (
    <PeriodChips
      items={HUB_ACQUISITION_PERIOD_ITEMS}
      current={current}
      paramKey="period"
      defaultValue="24h"
      ariaNoun="window"
    />
  );
}
