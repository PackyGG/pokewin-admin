import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/** Matches /audit: hero, KPI strip, filter toolbar, audit events table. */
export default function AuditLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <KpiStripSkeleton count={4} />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={160} />
        <ToolbarSkeleton filters={2} />
        <TableSkeleton rows={15} columns={6} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
