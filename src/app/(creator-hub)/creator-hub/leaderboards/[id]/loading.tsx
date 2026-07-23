import { PageHeroSkeleton } from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for Creator Hub → Leaderboard detail.
 */
export default function CreatorHubLeaderboardDetailLoading() {
    return (
        <div className="space-y-6">
            <PageHeroSkeleton />
            <Skeleton className="h-[180px] rounded-lg" />
            <Skeleton className="h-[320px] rounded-lg" />
        </div>
    );
}
