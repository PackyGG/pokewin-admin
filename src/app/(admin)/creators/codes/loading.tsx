import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /creators/codes: hero, 3-tile KPI strip (Total / Active /
 * Inactive), search toolbar (no filter dropdowns), and a 4-column
 * affiliate codes table (Code / Owner / Status / Created).
 */
export default function CreatorCodesLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <KpiStripSkeleton count={3} />
      <div className="space-y-4">
        <ToolbarSkeleton filters={0} />
        <TableSkeleton rows={12} columns={4} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
