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
  // Honest label: the Hub's "all" value is a bounded 365-day trailing
  // lookback (HUB_LIFETIME_LOOKBACK_DAYS), not true lifetime — say so.
  { value: "all", label: "365d" },
];

/**
 * Honest window label for the Hub's active period — the "all" chip maps to a
 * bounded 365-day lookback in every Hub query (hub-period-sql.ts), so it must
 * never be described as "all time". Lowercase, for inline byline/sub use.
 */
export function hubWindowLabel(period: DashboardPeriod): string {
  return period === "all" ? "last 365 days" : `last ${period}`;
}

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
