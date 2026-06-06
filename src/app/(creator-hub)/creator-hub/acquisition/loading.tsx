import { PageHeroSkeleton } from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for Creator Hub → Acquisition — keeps the Hub
 * chrome visible on a cold navigation while the active window's affiliate
 * analytics + funnel resolve. The in-page `<Suspense key={period}>` handles
 * window swaps; this only renders on the first paint of a cold nav.
 *
 * Mirrors the page chrome: pink hero with period selector, 8 Hub KPI boxes,
 * two chart cards, and the funnel card.
 */
export default function CreatorHubAcquisitionLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-[104px] rounded-2xl" />
        ))}
      </div>

      <div className="space-y-3">
        <Skeleton className="h-5 w-32 rounded" />
        <div className="grid gap-4 lg:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-[340px] rounded-2xl" />
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <Skeleton className="h-5 w-40 rounded" />
        <Skeleton className="h-[420px] rounded-2xl" />
      </div>
    </div>
  );
}
