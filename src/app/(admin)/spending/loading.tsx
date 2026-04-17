import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  TabBarSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/** Matches /spending: hero (date range), summary cards, tabs, table + trend chart. */
export default function SpendingLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <KpiStripSkeleton count={4} />
      <div className="space-y-4">
        <TabBarSkeleton count={3} />
        <Skeleton className="h-64 rounded-2xl" />
        <TableSkeleton rows={10} columns={6} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
