import { PageHeroSkeleton } from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/** Matches /antifraud/reviews: hero, count-backed queue tabs, and case cards. */
export default function ReviewQueueLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <div className="space-y-4">
        <Skeleton className="h-24 w-full rounded-xl" />
        <div className="flex items-center gap-2.5">
          <Skeleton className="size-7 rounded-lg" />
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      </div>
    </div>
  );
}
