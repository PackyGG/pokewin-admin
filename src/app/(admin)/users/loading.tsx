import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  ToolbarSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";
import { SkeletonTable } from "@/components/ux";

/**
 * Matches /users: hero, 4-tile KPI strip (Total Users · Banned · Depositors
 * · Signups 24h), "All Users" section heading, toolbar (search only — the
 * role/status dropdowns were removed 2026-07-23, hence filters={0}), users
 * table, pagination. Shapes mirror page.tsx 1:1 so the real content swaps in
 * without layout jump — the real strip renders 4 tiles on a 2-up/4-up grid,
 * so the skeleton must too.
 */
export default function UsersLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <KpiStripSkeleton count={4} />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={120} />
        <div className="space-y-4">
          <ToolbarSkeleton filters={0} />
          {/* Fixed-height rows matched to the real desktop table: a
              `size-9` avatar in a `p-2` cell renders ~52px tall, and the
              default page size is 20 rows. SkeletonTable pins each row to
              that height (vs TableSkeleton's content-driven `py-3` rows) so
              the real list swaps in with no vertical jump (CLS). */}
          <SkeletonTable rows={20} columns={7} rowHeight={52} />
          <PaginationSkeleton />
        </div>
      </div>
    </div>
  );
}
