import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  ChartSkeleton,
  StatPanelSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

/**
 * Route-level loading state shown on first navigation into
 * /rewards/analytics before any tab content streams in. Tabs have
 * their own sized skeletons via Suspense; this only covers the
 * cold-start. Defaults to the Overview shape since that's the
 * default tab when no `?category=` is set.
 */
export default function RewardsAnalyticsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      {/* Tab bar — small pill row. */}
      <Skeleton className="h-9 w-[480px] max-w-full rounded-lg" />
      <KpiStripSkeleton count={6} />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={220} />
        <ChartSkeleton height={340} title={false} />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="space-y-3">
          <SectionHeadingSkeleton titleWidth={180} />
          <Skeleton className="h-72 rounded-2xl" />
        </div>
        <div className="space-y-3">
          <SectionHeadingSkeleton titleWidth={160} />
          <StatPanelSkeleton rows={6} />
        </div>
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={180} />
        <TableSkeleton rows={8} columns={4} />
      </div>
    </div>
  );
}
