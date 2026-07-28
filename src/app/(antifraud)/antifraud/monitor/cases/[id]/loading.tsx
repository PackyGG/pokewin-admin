import { PageHeroSkeleton } from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Hard-navigation fallback. Mirrors the page shell (hero + KPI strip +
 * two-column body) so the layout does not jump when the case streams in.
 */
export default function MonitorCaseDetailLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-24 rounded-xl" />
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          <Skeleton className="h-64 w-full rounded-xl" />
          <div className="space-y-3">
            <div className="flex items-center gap-2.5">
              <Skeleton className="size-7 rounded-lg" />
              <Skeleton className="h-4 w-28" />
            </div>
            <Skeleton className="h-40 w-full rounded-xl" />
          </div>
          <div className="space-y-3">
            <div className="flex items-center gap-2.5">
              <Skeleton className="size-7 rounded-lg" />
              <Skeleton className="h-4 w-28" />
            </div>
            <Skeleton className="h-64 w-full rounded-xl" />
          </div>
        </div>
        <div className="space-y-4">
          <div className="flex items-center gap-2.5">
            <Skeleton className="size-7 rounded-lg" />
            <Skeleton className="h-4 w-28" />
          </div>
          <Skeleton className="h-96 w-full rounded-xl" />
        </div>
      </div>
    </div>
  );
}
