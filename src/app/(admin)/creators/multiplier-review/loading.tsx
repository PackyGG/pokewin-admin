import {
  PageHeroSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for /creators/multiplier-review — keeps the
 * shell visible on a cold navigation while the global review queue + the
 * KPI counts resolve.
 *
 * Mirrors the page chrome 1:1: the hero (with the flagged-only filter
 * reserved via the action slot), the 4-tile KPI grid (awaiting / flagged /
 * total / oldest — reproduced with the page's own
 * `grid-cols-2 sm:grid-cols-4` so the breakpoints match), then the review
 * queue table inside its bordered card.
 */
export default function MultiplierReviewLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />

      {/* KPI grid — matches the page's grid-cols-2 sm:grid-cols-4. */}
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="rounded-xl border bg-card px-3 py-2.5 sm:px-4 sm:py-3"
          >
            <div className="flex items-center gap-1.5 sm:gap-2">
              <Skeleton className="size-3.5 rounded sm:size-4" />
              <Skeleton className="h-3 w-16 rounded sm:w-20" />
            </div>
            <Skeleton className="mt-1.5 h-5 w-12 rounded sm:mt-2 sm:h-6 sm:w-16" />
          </div>
        ))}
      </div>

      {/* Review queue table (TableSkeleton supplies its own card chrome). */}
      <TableSkeleton rows={10} columns={6} />
    </div>
  );
}
