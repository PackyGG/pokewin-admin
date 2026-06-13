import { PageHeroSkeleton } from "@/components/loading-skeletons";
import { ChallengesContentSkeleton } from "./_components/content-skeleton";

/**
 * Route-level loading skeleton for /insights/challenges — keeps the shell
 * visible on a cold navigation while the page's server component resolves.
 * The in-page `<Suspense>` handles period swaps; this only renders on the
 * first paint of a cold nav.
 */
export default function ChallengesInsightsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <ChallengesContentSkeleton />
    </div>
  );
}
