import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  ChartRowSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /dashboard: PageHero, 5-tile primary stats, 4-tile secondary
 * stats, Trends section (3 charts), Recent Activity section (table).
 */
export default function DashboardLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <KpiStripSkeleton count={5} />
      <KpiStripSkeleton count={4} />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={80} />
        <ChartRowSkeleton count={3} height={300} />
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={160} />
        <TableSkeleton rows={8} columns={6} />
      </div>
    </div>
  );
}
