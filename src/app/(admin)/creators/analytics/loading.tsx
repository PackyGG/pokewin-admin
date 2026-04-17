import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  ChartRowSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

/** Matches /creators/analytics: hero (period filter), stats, charts, leaderboards table. */
export default function CreatorAnalyticsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <KpiStripSkeleton count={6} />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={100} />
        <ChartRowSkeleton count={2} height={300} />
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={160} />
        <TableSkeleton rows={10} columns={6} />
      </div>
    </div>
  );
}
