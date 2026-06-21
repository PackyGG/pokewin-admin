import {
  PageHeroSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for the Pack Studio shell. Mirrors the hero,
 * a quick-tools row, and an overview heading + KPI grid — the same skeleton
 * geometry the Creator Hub uses so the first paint matches the eventual
 * page layout.
 */
export default function PackStudioLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />

      {/* Quick tools — 4 tiles (one per Studio nav destination). */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[72px] rounded-2xl" />
        ))}
      </div>

      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={100} action />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[104px] rounded-2xl" />
          ))}
        </div>
      </div>
    </div>
  );
}
