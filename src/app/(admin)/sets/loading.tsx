import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  ToolbarSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";
import { SetsTableSkeleton } from "./_skeletons";

/**
 * Matches /sets: hero (seed / absorb / create actions), 3-tile KPI strip
 * (Total Sets · Series · Total Cards), section heading, filter toolbar,
 * and the sets table. Mirrors the page layout so route navigation into
 * /sets reserves the right space instead of flashing blank.
 */
export default function SetsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <KpiStripSkeleton count={3} />
      <div className="space-y-3">
        <SectionHeadingSkeleton />
        <div className="space-y-4">
          <ToolbarSkeleton filters={1} />
          <SetsTableSkeleton />
          <PaginationSkeleton />
        </div>
      </div>
    </div>
  );
}
