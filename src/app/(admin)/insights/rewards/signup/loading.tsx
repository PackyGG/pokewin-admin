import {
  PageHeroSkeleton,
  TabBarSkeleton,
} from "@/components/loading-skeletons";
import { SignupInsightsTabSkeleton } from "./_components/tab-skeleton";

/**
 * Route-level loading skeleton for /insights/rewards/signup — keeps the
 * shell visible on a cold navigation while the active tab's server
 * component resolves. The per-tab `<Suspense>` in page.tsx handles
 * post-mount tab swaps; this only renders on the first paint of a cold nav.
 *
 * Mirrors the page chrome (hero with period filter + export action, then
 * the 13-tab switch) over the default Overview body — reusing the page's
 * own `SignupInsightsTabSkeleton` (KPI strip + chart + two panels) so the
 * body matches the real tab content 1:1 and nothing jumps.
 */
export default function SignupInsightsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <TabBarSkeleton count={13} />
      <SignupInsightsTabSkeleton />
    </div>
  );
}
