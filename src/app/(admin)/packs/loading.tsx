import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  ToolbarSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";
import { PackGridSkeleton } from "./_skeletons";

/** Matches /packs: hero, 5-tile KPI strip, section heading, toolbar, grid. */
export default function PacksLoading() {
  // Grid skeleton mirrors <PacksGrid>/<PackTile> exactly (column counts +
  // per-tile anatomy) so the swap to real data doesn't pop.
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <KpiStripSkeleton count={5} />
      <div className="space-y-3">
        <SectionHeadingSkeleton />
        <ToolbarSkeleton filters={1} />
        <PackGridSkeleton />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
