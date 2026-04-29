import { Skeleton } from "@/components/ui/skeleton";
import {
  DetailHeroSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /creators/leaderboards/[id]: detail hero with back arrow + status
 * badges + trailing detail actions, four definition cards in a 2x2 grid
 * (Definition / Prize pool / Approval lifecycle / Cancellation & refund),
 * and a 2-column prize tiers table.
 */
export default function CreatorLeaderboardDetailLoading() {
  return (
    <div className="space-y-6">
      <DetailHeroSkeleton action />

      <div className="grid gap-6 md:grid-cols-2">
        <Skeleton className="h-56 rounded-lg" />
        <Skeleton className="h-56 rounded-lg" />
        <Skeleton className="h-56 rounded-lg" />
        <Skeleton className="h-56 rounded-lg" />
      </div>

      <TableSkeleton rows={5} columns={2} />
    </div>
  );
}
