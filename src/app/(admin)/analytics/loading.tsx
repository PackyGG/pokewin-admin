import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  ChartRowSkeleton,
  TabBarSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /analytics: hero (with period filter action), 9-tab nav, and
 * the default Overview tab content (6 KPIs, 2 breakdown cards, charts).
 * Other analytics tabs use Suspense + TabSkeleton internally — this
 * top-level skeleton only fires on cold navigations to /analytics.
 */
export default function AnalyticsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <TabBarSkeleton count={9} />
      <KpiStripSkeleton count={6} />
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-64 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={140} />
        <ChartRowSkeleton count={3} height={300} />
      </div>
    </div>
  );
}
