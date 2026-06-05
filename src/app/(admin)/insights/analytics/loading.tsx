import {
  PageHeroSkeleton,
  TabBarSkeleton,
} from "@/components/loading-skeletons";
import { InsightsTabSkeleton } from "./tab-skeleton";

/**
 * Route-level loading skeleton for /insights/analytics — keeps the shell
 * visible on a cold navigation while the active tab's server component
 * resolves. The per-tab `<Suspense>` in page.tsx handles post-mount tab
 * swaps; this only renders on the first paint of a cold nav.
 *
 * Mirrors the page chrome (hero with period filter + export action, then
 * the 10-tab nav) over the default Overview body — reusing the page's own
 * `InsightsTabSkeleton` (6-tile KPI strip over two stacked chart cards) so
 * the body matches the real tab content 1:1 and nothing jumps.
 */
export default function InsightsAnalyticsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <TabBarSkeleton count={10} />
      <InsightsTabSkeleton />
    </div>
  );
}
