import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  TabBarSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
  PaginationSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /vouchers: hero (no trailing action), 4 KPI tiles, "Voucher
 * List" section with 2 tabs (Unclaimed / Claimed — default unclaimed),
 * search toolbar with Created By filter + value-range filter, and the
 * 6-column default unclaimed-tab table.
 */
export default function VouchersLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <KpiStripSkeleton count={4} />
      <div className="space-y-4">
        <SectionHeadingSkeleton titleWidth={120} />
        <TabBarSkeleton count={2} />
        <ToolbarSkeleton filters={2} />
        <TableSkeleton rows={12} columns={6} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
