import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHeroSkeleton,
  KpiStripSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /creators/ads: hero (badge + create), 6-tile KPI strip,
 * conversion summary card, search row, then the ad-code CARD GRID
 * (1 / 2 / 3 / 4 cols) — not a table. Card-shaped skeletons mirror
 * AdsList so nothing jumps when the real cards load.
 */
export default function AdsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <KpiStripSkeleton count={6} />
      <Skeleton className="h-20 rounded-2xl" />
      <div className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Skeleton className="h-9 w-full max-w-sm rounded-md" />
          <Skeleton className="h-4 w-16" />
        </div>
        <div className="grid gap-3 grid-cols-1 sm:gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-56 rounded-2xl" />
          ))}
        </div>
      </div>
    </div>
  );
}
