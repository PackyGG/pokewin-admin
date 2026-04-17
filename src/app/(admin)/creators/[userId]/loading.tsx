import { Skeleton } from "@/components/ui/skeleton";
import {
  DetailHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  TabBarSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /creators/[userId]: detail hero, overview card, stat tiles,
 * tabs with table + panels.
 */
export default function CreatorDetailLoading() {
  return (
    <div className="space-y-6">
      <DetailHeroSkeleton action />
      <Skeleton className="h-40 rounded-2xl" />
      <KpiStripSkeleton count={4} />
      <div className="space-y-4">
        <TabBarSkeleton count={4} />
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-48 rounded-2xl" />
          <Skeleton className="h-48 rounded-2xl" />
        </div>
        <div className="space-y-3">
          <SectionHeadingSkeleton titleWidth={120} />
          <TableSkeleton rows={8} columns={5} />
          <PaginationSkeleton />
        </div>
      </div>
    </div>
  );
}
