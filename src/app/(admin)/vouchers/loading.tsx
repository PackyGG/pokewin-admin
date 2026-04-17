import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  TabBarSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/** Matches /vouchers: hero, KPI strip, claimed/unclaimed tabs, toolbar, table. */
export default function VouchersLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <KpiStripSkeleton count={4} />
      <div className="space-y-4">
        <TabBarSkeleton count={2} />
        <ToolbarSkeleton filters={2} />
        <TableSkeleton rows={12} columns={7} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
