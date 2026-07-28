import { Skeleton } from "@/components/ui/skeleton";
import {
  DetailHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  GridSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /packs/[id]: detail hero with pack art + toggle/edit/delete
 * actions, the Economics block (4 metric tiles + a 4-tile pool row), the
 * 4-tile lifetime-performance row, the deferred stats block (period-tiles
 * card + two charts), then the "Pack contents" section with a cards grid.
 */
export default function PackDetailLoading() {
  return (
    <div className="space-y-6">
      <DetailHeroSkeleton action />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={110} />
        <KpiStripSkeleton count={4} />
        <KpiStripSkeleton count={4} />
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={170} />
        <KpiStripSkeleton count={4} />
      </div>
      {/* Stats block — mirrors the page's own deferred-stats Suspense fallback
          (no section heading above it on the real page): a period-tiles card
          plus two chart boxes sized to the real h-[250px] charts. Matching the
          shape + heights here keeps the route-loading → streamed-page handoff
          from jumping. */}
      <div className="space-y-4">
        <Skeleton className="h-32 rounded-xl" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-[250px] rounded-xl" />
          <Skeleton className="h-[250px] rounded-xl" />
        </div>
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={140} />
        <GridSkeleton count={18} aspect="card" />
      </div>
    </div>
  );
}
