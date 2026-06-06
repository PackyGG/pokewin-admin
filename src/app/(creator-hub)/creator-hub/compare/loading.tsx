import { PageHeroSkeleton, SectionHeadingSkeleton } from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for Creator Hub → Compare. Mirrors the page
 * chrome: hero, selection row + period control, then side-by-side columns.
 */
export default function CompareLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />

      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={100} action />
        <div className="space-y-3">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-9 max-w-md" />
        </div>
      </div>

      <div className="space-y-6">
        <Skeleton className="h-3 w-64" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-2xl" />
          ))}
        </div>
        {Array.from({ length: 4 }).map((_, s) => (
          <div key={s} className="space-y-3">
            <SectionHeadingSkeleton titleWidth={120} />
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {Array.from({ length: 2 }).map((_, i) => (
                <Skeleton key={i} className="h-44 rounded-xl" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
