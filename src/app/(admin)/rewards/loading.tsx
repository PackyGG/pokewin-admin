import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  TabBarSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /rewards: hero, RewardsOverview (stat cards), type tabs,
 * rewards table with create button.
 */
export default function RewardsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <KpiStripSkeleton count={4} />
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <TabBarSkeleton count={4} />
          <Skeleton className="h-9 w-32" />
        </div>
        <ToolbarSkeleton filters={1} />
        <TableSkeleton rows={10} columns={6} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
