import { PageHeroSkeleton } from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/** Matches /antifraud/reviews: hero, filter card, case list. */
export default function ReviewQueueLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <Skeleton className="h-28 w-full rounded-xl" />
      <div className="space-y-4">
        <div className="flex items-center gap-2.5">
          <Skeleton className="size-7 rounded-lg" />
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="overflow-hidden rounded-xl border border-border/60">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-none" />
          ))}
        </div>
      </div>
    </div>
  );
}
