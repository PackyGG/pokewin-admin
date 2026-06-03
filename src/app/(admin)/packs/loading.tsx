import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";
import {
  EntityTableSkeleton,
  FilterBarSkeleton,
} from "@/components/entity-surface";

/**
 * Route-level loading for /packs: hero, 5-tile KPI strip, section heading,
 * filter bar, and the dense triage TABLE skeleton (the default view). The
 * table skeleton mirrors <EntityTable>'s chrome (sticky header band + fixed
 * row height) so the swap to real data doesn't shift. When the operator has
 * the gallery view selected the per-view skeleton in page.tsx's inner Suspense
 * takes over on the next navigation; this static shell defaults to the
 * triage-first table.
 */
export default function PacksLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <KpiStripSkeleton count={5} />
      <div className="space-y-3">
        <SectionHeadingSkeleton />
        <FilterBarSkeleton filters={1} />
        <EntityTableSkeleton rows={12} columns={7} selectable={false} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
