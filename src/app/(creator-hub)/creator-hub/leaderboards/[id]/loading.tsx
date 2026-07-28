import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for Creator Hub → Leaderboard detail.
 * Mirrors the streamed shell: back-affordance row, title + badge lines +
 * creator line, then the summary / claims / standings blocks in the same
 * heights and radii the page's own `DetailSkeleton` streams.
 */
export default function CreatorHubLeaderboardDetailLoading() {
  return (
    <div className="space-y-6">
      {/* PageHeroIdentity back-affordance row */}
      <div className="mb-4 flex items-center sm:mb-6">
        <Skeleton className="size-9 rounded-md" />
      </div>

      {/* Title + badges + creator line */}
      <div className="space-y-2">
        <Skeleton className="h-8 w-64 rounded" />
        <div className="flex items-center gap-2">
          <Skeleton className="h-5 w-20 rounded-full" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
        <Skeleton className="h-5 w-40 rounded" />
      </div>

      {/* Summary / claims / standings — same shapes as the in-page fallback */}
      <Skeleton className="h-[220px] rounded-xl" />
      <Skeleton className="h-[180px] rounded-xl" />
      <Skeleton className="h-[320px] rounded-xl" />
    </div>
  );
}
