import {
  PageHeroSkeleton,
  SectionHeadingSkeleton,
  TabBarSkeleton,
} from "@/components/loading-skeletons";
import { SkeletonChart, SkeletonKpiStrip } from "@/components/ux";

/**
 * Matches /analytics: hero, 6-tab deep-dive strip + period filter row, then
 * the default one-page overview (Acquisition KPI strip + chart, followed by
 * the first core sections). Deep-dive tabs use Suspense + TabSkeleton
 * internally — this top-level skeleton only fires on cold navigations.
 */
export default function AnalyticsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <TabBarSkeleton count={6} />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={120} />
        <SkeletonKpiStrip count={3} className="sm:grid-cols-3" />
        <SkeletonChart height={300} variant="area" />
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={140} />
        <SkeletonKpiStrip count={3} className="sm:grid-cols-3" />
        <SkeletonChart height={300} variant="bars" />
      </div>
    </div>
  );
}
