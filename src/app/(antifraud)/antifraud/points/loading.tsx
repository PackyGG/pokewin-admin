import { PageHeroSkeleton } from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Matches /antifraud/points exactly: the shared hero shell, then the summary
 * strip, severity bands and the score sections that `PointsSkeleton` mirrors.
 */
export default function AntifraudPointsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="space-y-5">
        <Skeleton className="h-16 rounded-lg" />
        <Skeleton className="h-20 rounded-lg" />
        <Skeleton className="h-52 rounded-lg" />
        <Skeleton className="h-52 rounded-lg" />
      </div>
    </div>
  );
}
