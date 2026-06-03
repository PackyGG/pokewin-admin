import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  ToolbarSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";
import { CardGridSkeleton } from "./_skeletons";

/**
 * Matches /cards: hero (create button), 5-tile KPI strip, tab switch,
 * filter toolbar, count line, dense 10-per-row card grid.
 */
export default function CardsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <KpiStripSkeleton count={5} />
      <div className="space-y-3">
        <ToolbarSkeleton filters={3} />
        {/* Count-summary line ("Showing N of M cards") placeholder. */}
        <Skeleton className="h-4 w-48" />
        <CardGridSkeleton />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
