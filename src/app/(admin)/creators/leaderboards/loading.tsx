import {
  PageHeroSkeleton,
  TabBarSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Matches /creators/leaderboards: hero with "Create" action, status tabs
 * (All / Pending / Approved / Rejected) + creator filter input on the same
 * row, and a 10-column table (Title, Creator, Approval, Time, Creator $,
 * Bonus $, Total $, Starts, Ends, Actions).
 */
export default function CreatorLeaderboardsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />

      <div className="space-y-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <TabBarSkeleton count={4} />
          <Skeleton className="h-9 w-64" />
        </div>

        <TableSkeleton rows={10} columns={10} />

        <div className="flex items-center justify-between text-sm">
          <Skeleton className="h-4 w-32" />
          <div className="flex gap-2">
            <Skeleton className="h-7 w-24 rounded-md" />
            <Skeleton className="h-7 w-24 rounded-md" />
          </div>
        </div>
      </div>
    </div>
  );
}
