import { PeriodChips } from "@/components/ux";
import { type DashboardPeriod } from "@/lib/queries/dashboard-period";

/**
 * Creator Hub dashboard timespan selector. Thin wrapper over the canonical
 * URL-driven `PeriodChips` (src/components/ux/period-chips.tsx) so the Hub
 * uses the exact same "flip ?period= without losing scroll / blanking the
 * page" mechanics as the rest of the admin.
 *
 * Default = 24h (the plan's required default). Selecting 24h clears the
 * param so the canonical Hub URL is bare. Only the active window's data is
 * fetched per render (the page wraps the data section in a Suspense boundary
 * keyed on `period`), so switching lazily loads just the picked window —
 * never preloading all of them (active-timeframe-only).
 *
 * The set is intentionally compact (24h / 7d / 30d / all). Server-safe:
 * PeriodChips carries its own "use client" boundary and takes only data
 * props, so this renders directly from the Server Component page.
 */

const HUB_PERIOD_ITEMS: { value: DashboardPeriod; label: string }[] = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All" },
];

export function HubPeriodSelector({ current }: { current: DashboardPeriod }) {
  return (
    <PeriodChips
      items={HUB_PERIOD_ITEMS}
      current={current}
      paramKey="period"
      defaultValue="24h"
      ariaNoun="window"
    />
  );
}
