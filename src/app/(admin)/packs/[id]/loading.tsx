import { Skeleton } from "@/components/ui/skeleton";
import {
  DetailHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  GridSkeleton,
} from "@/components/loading-skeletons";

/** Matches /packs/[id]: detail hero with pack art, stats strip, cards grid. */
export default function PackDetailLoading() {
  return (
    <div className="space-y-6">
      <DetailHeroSkeleton action />
      <KpiStripSkeleton count={4} />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={120} />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={140} />
        <GridSkeleton count={18} aspect="card" />
      </div>
    </div>
  );
}
