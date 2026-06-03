import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  ChartRowSkeleton,
  TabBarSkeleton,
} from "@/components/loading-skeletons";
import { SkeletonChart } from "@/components/ux";

/**
 * Matches /analytics: hero (with period filter action), 9-tab nav, and
 * the default Overview tab content (6 KPIs, 2 breakdown cards, charts).
 * Other analytics tabs use Suspense + TabSkeleton internally — this
 * top-level skeleton only fires on cold navigations to /analytics.
 *
 * The two breakdown cards use the chart-card silhouette so the cold-load
 * state reads as content (not flat grey boxes) and stays dimension-stable
 * when the real panels stream in.
 */
export default function AnalyticsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <TabBarSkeleton count={9} />
      <KpiStripSkeleton count={6} />
      <div className="grid gap-4 md:grid-cols-2">
        <SkeletonChart height={256} variant="area" title={false} />
        <SkeletonChart height={256} variant="area" title={false} />
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={140} />
        <ChartRowSkeleton count={3} height={300} />
      </div>
    </div>
  );
}
