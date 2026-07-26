import {
  PageHeroSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for the Creator Hub dashboard. Mirrors the
 * hero, four-tool quick row, overview heading, KPI grid, 3-up charts row,
 * fixed four-week summary, and the two full-width chart sections.
 */
export default function CreatorHubDashboardLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />

      {/* Quick tools — 4 tiles. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[72px] rounded-2xl" />
        ))}
      </div>

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
          {/* Fixed four-week deal summary. */}
          <div className="space-y-3">
            <SectionHeadingSkeleton titleWidth={80} />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-[104px] rounded-2xl" />
              ))}
            </div>
          </div>

          {/* Creator-costs time-series chart. */}
          <SectionHeadingSkeleton titleWidth={180} />
          <Skeleton className="h-[300px] rounded-2xl" />

          {/* Sign-ups and FTDs chart. */}
          <Skeleton className="h-[300px] rounded-2xl" />
        </div>
      </div>
    </div>
  );
}
