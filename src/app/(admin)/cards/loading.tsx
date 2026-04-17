import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  ToolbarSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /cards: hero (create button), 5-tile KPI strip, filter toolbar,
 * dense 10-per-row card grid.
 */
export default function CardsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <KpiStripSkeleton count={5} />
      <div className="space-y-4">
        <ToolbarSkeleton filters={3} />
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-7 xl:grid-cols-10">
          {Array.from({ length: 40 }).map((_, i) => (
            <Skeleton
              key={i}
              className="rounded-xl"
              style={{ aspectRatio: "3 / 4.6" }}
            />
          ))}
        </div>
        <PaginationSkeleton />
      </div>
    </div>
  );
}
