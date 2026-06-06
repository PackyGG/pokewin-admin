import { PageHeroSkeleton, SectionHeadingSkeleton } from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for Creator Hub → Deal Tracker.
 */
export default function CreatorHubDealTrackerLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[104px] rounded-2xl" />
        ))}
      </div>

      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={100} />
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-[88px] rounded-2xl" />
          ))}
        </div>
      </div>
    </div>
  );
}
