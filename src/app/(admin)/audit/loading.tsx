import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /audit: hero, 3 KPI tiles (Total Events / On Page / Event
 * Types), search toolbar with single Event Type filter, and the audit
 * events table.
 */
export default function AuditLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <KpiStripSkeleton count={3} />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={160} />
        <ToolbarSkeleton filters={1} />
        <TableSkeleton rows={15} columns={6} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
