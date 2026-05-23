import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /users: hero, 4-tile KPI strip, "All Users" section heading,
 * toolbar (search + role + status), users table, pagination. Shapes
 * mirror page.tsx 1:1 so the real content swaps in without layout jump.
 */
export default function UsersLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <KpiStripSkeleton count={4} />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={120} />
        <div className="space-y-4">
          <ToolbarSkeleton filters={2} />
          <TableSkeleton rows={15} columns={7} />
          <PaginationSkeleton />
        </div>
      </div>
    </div>
  );
}
