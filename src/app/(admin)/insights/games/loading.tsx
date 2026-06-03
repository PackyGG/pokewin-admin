import {
  PageHeroSkeleton,
  TabBarSkeleton,
  KpiStripSkeleton,
} from "@/components/loading-skeletons";
import { SkeletonChart } from "@/components/ux";

/**
 * Route-level loading skeleton — keeps the shell visible while the
 * Server Component resolves on a cold navigation. The per-tab Suspense
 * in page.tsx handles the post-mount tab swaps.
 *
 * Mirrors the page chrome (hero with period filter + 6-tab nav) over the
 * default Overview shape (KPI strip + chart), using layout-matching
 * silhouettes so the layout doesn't jump when the data lands.
 */
export default function Loading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <TabBarSkeleton count={6} />
      <KpiStripSkeleton count={6} />
      <SkeletonChart height={320} variant="area" />
    </div>
  );
}
