import { SectionHeadingSkeleton } from "@/components/loading-skeletons";

import {
  LeaderboardsControlsSkeleton,
  LeaderboardsKpiSkeleton,
  LeaderboardsRanklistSkeleton,
} from "./_components/list-skeletons";

/**
 * Route-level loading skeleton for Creator Hub → Live Leaderboards. Mirrors
 * the real shell exactly: SectionHeading opener with the controls row (view
 * chips + sort select), the 5-tile KPI strip, then the ranked row list —
 * same shared skeleton components the in-page Suspense fallbacks use.
 */
export default function CreatorHubLeaderboardsLoading() {
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <SectionHeadingSkeleton titleWidth={140} />
          <LeaderboardsControlsSkeleton />
        </div>
        <LeaderboardsKpiSkeleton />
      </div>

      <LeaderboardsRanklistSkeleton />
    </div>
  );
}
