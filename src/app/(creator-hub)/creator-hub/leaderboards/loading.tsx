import {
  PageHeroSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for Creator Hub → Live Leaderboards. Mirrors
 * the hero, KPI strip, section heading + rank chips, and ranked row list.
 */
export default function CreatorHubLeaderboardsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />

      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[88px] rounded-xl" />
          ))}
        </div>

        <div className="space-y-3">
          <SectionHeadingSkeleton titleWidth={120} action />
          <div className="space-y-2.5">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-[80px] rounded-xl" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
