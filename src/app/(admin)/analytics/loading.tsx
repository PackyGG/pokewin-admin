import {
  PageTitleSkeleton,
  StatCardRowSkeleton,
  ChartRowSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

// Matches /analytics: title + period filter, 6 stat cards, battle/pack
// breakdown sections, 3-col chart grid.
export default function AnalyticsLoading() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <PageTitleSkeleton width={140} />
        <Skeleton className="h-9 w-[220px]" />
      </div>
      <StatCardRowSkeleton count={3} />
      <Skeleton className="h-64 rounded-xl" />
      <Skeleton className="h-64 rounded-xl" />
      <ChartRowSkeleton count={3} height={300} />
    </div>
  );
}
