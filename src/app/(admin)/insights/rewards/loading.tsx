import {
  PageHeroSkeleton,
  TabBarSkeleton,
} from "@/components/loading-skeletons";
import { InsightsRewardsTabSkeleton } from "./_components/tab-skeleton";

/**
 * Route-level loading skeleton for /insights/rewards — keeps the shell
 * visible on a cold navigation while the active tab's server component
 * resolves. The per-tab `<Suspense>` in page.tsx handles post-mount tab
 * swaps; this only renders on the first paint of a cold nav.
 *
 * Mirrors the page chrome (hero with period filter + export action, then
 * the 10-tab switch) over the default Overview tab body — reusing the
 * page's own `InsightsRewardsTabSkeleton` so the body matches the real
 * tab content 1:1 and nothing jumps when the data lands.
 */
export default function InsightsRewardsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <TabBarSkeleton count={10} />
      <InsightsRewardsTabSkeleton />
    </div>
  );
}
