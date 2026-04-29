import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  TabBarSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /spending: hero with date-range filter, summary cards (rendered
 * via SummaryCards — typically 4 KPI tiles + a small trend chart), 2-tab
 * bar (Expenses / Recurring), and the active tab's table.
 */
export default function SpendingLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <KpiStripSkeleton count={4} />
      <div className="space-y-4">
        <TabBarSkeleton count={2} />
        <TableSkeleton rows={10} columns={6} />
      </div>
    </div>
  );
}
