import { Skeleton } from "@/components/ui/skeleton";
import {
  DetailHeroSkeleton,
  TabBarSkeleton,
  SectionHeadingSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /admin-users/[id]: detail hero, tabs (Overview / Permissions /
 * Limits / Audit), tabbed content.
 */
export default function AdminUserDetailLoading() {
  return (
    <div className="space-y-6">
      <DetailHeroSkeleton action />
      <TabBarSkeleton count={4} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-64 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={120} />
        <TableSkeleton rows={8} columns={5} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
