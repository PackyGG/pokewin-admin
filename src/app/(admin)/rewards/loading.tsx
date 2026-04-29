import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  TabBarSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /rewards: hero, RewardsOverview (4 stat cards), 4 type tabs
 * (All / One Time / Daily / Balance) + Create button on the same row,
 * and an 8-column rewards table (Name / Slug / Type / Level / Cash /
 * Packs / Created / Actions). No toolbar — type filter is handled via
 * tabs.
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
        <TableSkeleton rows={10} columns={8} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
