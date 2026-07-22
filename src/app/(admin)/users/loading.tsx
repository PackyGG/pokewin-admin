import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  ToolbarSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";
import { SkeletonTable } from "@/components/ux";

/**
 * Matches /users: hero, 3-tile KPI strip (Total Users · Banned · Signups
 * 24h), "All Users" section heading, toolbar (search + role + status),
 * users table, pagination. Shapes mirror page.tsx 1:1 so the real content
 * swaps in without layout jump — the real strip renders exactly 3 tiles in
 * a `grid-cols-3`, so the skeleton must too.
 */
export default function UsersLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <KpiStripSkeleton count={3} />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={120} />
        <div className="space-y-4">
          <ToolbarSkeleton filters={2} />
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
