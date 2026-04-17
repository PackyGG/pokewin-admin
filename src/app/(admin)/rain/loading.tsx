import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHeroSkeleton,
  TabBarSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/** Matches /rain: hero, Instances/Config tabs, rain table or config cards. */
export default function RainLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="space-y-4">
        <TabBarSkeleton count={2} />
        <Skeleton className="h-24 rounded-2xl" />
        <TableSkeleton rows={10} columns={6} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
