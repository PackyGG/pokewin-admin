import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/** Matches /promo-codes: hero (create button), KPI strip, toolbar, table. */
export default function PromoCodesLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <KpiStripSkeleton count={4} />
      <div className="space-y-4">
        <ToolbarSkeleton filters={2} />
        <TableSkeleton rows={12} columns={7} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
