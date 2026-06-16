import {
  PageHeroSkeleton,
  SectionHeadingSkeleton,
  KpiStripSkeleton,
  ChartSkeleton,
  StatPanelSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /xp-sales: hero (no action — the period filter lives in the
 * section heading), the "XP sales" section heading with its period-filter
 * action, the 4-tile KPI strip (revenue / sales / buyers / avg per sale),
 * the daily-revenue chart panel, and the recent-sales list panel. Mirrors
 * the in-page Suspense fallback shape so cold navigations commit to a
 * layout-stable skeleton instead of a blank screen.
 */
export default function XpSalesLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={120} action />
        <KpiStripSkeleton count={4} />
        <ChartSkeleton height={320} />
        <StatPanelSkeleton rows={6} />
      </div>
    </div>
  );
}
