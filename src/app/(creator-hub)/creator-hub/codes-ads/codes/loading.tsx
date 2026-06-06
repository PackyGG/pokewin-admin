import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/** Matches /creator-hub/codes-ads/codes list layout. */
export default function CreatorHubCodesLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <Skeleton className="h-11 w-full max-w-xs rounded-xl" />
      <KpiStripSkeleton count={3} />
      <div className="space-y-4">
        <ToolbarSkeleton filters={0} />
        <TableSkeleton rows={12} columns={4} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
