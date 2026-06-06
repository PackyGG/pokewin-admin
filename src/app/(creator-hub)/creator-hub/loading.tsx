import {
  PageHeroSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for the Creator Hub dashboard. Mirrors the
 * hero, quick-tools row, Creator Check widget, overview heading, KPI grid,
 * and 3-up charts row.
 */
export default function CreatorHubDashboardLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />

      {/* Quick tools — 5 tiles. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-[72px] rounded-2xl" />
        ))}
      </div>

      {/* Creator Check widget. */}
      <Skeleton className="h-[88px] rounded-2xl" />

      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={100} action />
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-[104px] rounded-2xl" />
            ))}
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-[260px] rounded-2xl" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
