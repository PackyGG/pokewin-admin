import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /promo-codes: hero with Create button, 4-tile KPI strip
 * (Total / Active / Expired / Redemptions), "All Codes" section heading,
 * search toolbar with single Status filter, and the codes table.
 */
export default function PromoCodesLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <KpiStripSkeleton count={4} />
      <div className="space-y-4">
        <ToolbarSkeleton filters={1} />
        <TableSkeleton rows={12} columns={7} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
