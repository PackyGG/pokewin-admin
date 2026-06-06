import {
  PageHeroSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for Creator Hub → Creators roster. Mirrors the
 * hero (with Add Creator action), section heading + tab/period controls,
 * toolbar row, and card grid.
 */
export default function CreatorHubRosterLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />

      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={80} action />

        <div className="space-y-4">
          {/* Toolbar — search + sort + view toggle. */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <Skeleton className="h-9 w-full max-w-xs rounded-md" />
            <div className="flex items-center gap-2">
              <Skeleton className="h-9 w-[170px] rounded-md" />
              <Skeleton className="h-9 w-[72px] rounded-lg" />
            </div>
          </div>

          <div className="space-y-2">
            <Skeleton className="h-3 w-28" />
            <div className="grid grid-cols-1 gap-3 sm:gap-4 md:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-56 rounded-2xl" />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
