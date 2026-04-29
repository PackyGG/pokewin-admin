import { Skeleton } from "@/components/ui/skeleton";
import {
  DetailHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /cards/[id]: detail hero with rarity badge + edit/delete actions,
 * 4-tile KPI strip (Price / HP / In Packs / In Inventory), card image +
 * detail rows panel, and an optional grid of packs containing this card.
 */
export default function CardDetailLoading() {
  return (
    <div className="space-y-6">
      <DetailHeroSkeleton action />
      <KpiStripSkeleton count={4} />
      <div className="rounded-2xl border bg-card p-5">
        <div className="flex gap-8 items-start flex-wrap">
          <Skeleton
            className="rounded-lg shrink-0"
            style={{ width: 200, aspectRatio: "3/4" }}
          />
          <div className="flex-1 grid grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-5 min-w-[240px]">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-3 w-14" />
                <Skeleton className="h-5 w-20" />
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={180} />
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16 rounded-md" />
          ))}
        </div>
      </div>
    </div>
  );
}
