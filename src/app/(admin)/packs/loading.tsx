import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  ToolbarSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/** Matches /packs: hero, 5-tile KPI strip, section heading, toolbar, grid. */
export default function PacksLoading() {
  // Packs grid is a responsive card layout — keep card proportions close
  // to the real PacksGrid so the swap doesn't pop.
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <KpiStripSkeleton count={5} />
      <div className="space-y-3">
        <SectionHeadingSkeleton />
        <ToolbarSkeleton filters={1} />
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {Array.from({ length: 18 }).map((_, i) => (
            <Skeleton
              key={i}
              className="rounded-xl"
              style={{ aspectRatio: "3/4" }}
            />
          ))}
        </div>
        <PaginationSkeleton />
      </div>
    </div>
  );
}
