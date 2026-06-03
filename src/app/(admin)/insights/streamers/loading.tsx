import {
  PageHeroSkeleton,
  TabBarSkeleton,
  KpiStripSkeleton,
} from "@/components/loading-skeletons";
import { SkeletonTable } from "@/components/ux";

/**
 * Route-level loading skeleton — fires while the Server Component
 * resolves on initial navigation. Matches the page chrome (hero + 6-tab
 * row + the default Overview shape: KPI strip + ranked-creator table) so
 * the layout doesn't jump when the data lands. Per-tab Suspense handles
 * post-mount tab swaps.
 */
export default function Loading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <TabBarSkeleton count={6} />
      <KpiStripSkeleton count={4} />
      <SkeletonTable rows={10} columns={6} />
    </div>
  );
}
