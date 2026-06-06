import { PeriodChips } from "@/components/ux";
import { type DashboardPeriod } from "@/lib/queries/dashboard-period";

/**
 * Creator Hub → Changelog timespan selector.
 *
 * Thin wrapper over the canonical URL-driven `PeriodChips`
 * (src/components/ux/period-chips.tsx), matching the Hub dashboard's own
 * selector (`../../_components/hub-period-selector.tsx`) so the whole Hub
 * uses one consistent window set + the same "flip ?period= without losing
 * scroll / blanking the page" mechanics as the rest of the admin.
 *
 * Set = 24h / 7d / 30d / all (the Hub-wide compact set). Default = 24h;
 * selecting 24h clears the param so the canonical changelog URL is bare.
 *
 * Active-timeframe-only: only the active window's feed is fetched per render
 * (the page wraps the feed in a `<Suspense key={period}>` boundary), so
 * switching lazily loads just the picked window — never preloading them all.
 *
 * Server-safe: `PeriodChips` carries its own "use client" boundary and takes
 * only data props, so this renders directly from the Server Component page.
 */

const HUB_CHANGELOG_PERIOD_ITEMS: { value: DashboardPeriod; label: string }[] = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All" },
];

export function HubChangelogPeriodSelector({
  current,
}: {
  current: DashboardPeriod;
}) {
  return (
    <PeriodChips
      items={HUB_CHANGELOG_PERIOD_ITEMS}
      current={current}
      paramKey="period"
      defaultValue="24h"
      ariaNoun="window"
    />
  );
}
