import { Skeleton } from "@/components/ui/skeleton";
import { ToolbarSkeleton } from "@/components/loading-skeletons";

/**
 * Loading skeleton mirrors the redesigned cards page layout 1:1:
 *   - Hero band
 *   - 5-tile KPI strip
 *   - Toolbar
 *   - Dense 10-per-row card grid
 */
export default function CardsLoading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-[92px] w-full rounded-2xl" />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-[78px] rounded-xl" />
        ))}
      </div>

      <div className="space-y-4">
        <ToolbarSkeleton />
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-7 xl:grid-cols-10">
          {Array.from({ length: 40 }).map((_, i) => (
            <Skeleton
              key={i}
              className="rounded-xl"
              style={{ aspectRatio: "3 / 4.6" }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
