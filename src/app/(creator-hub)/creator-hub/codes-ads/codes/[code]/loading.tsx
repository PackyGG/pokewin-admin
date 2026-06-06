import { Skeleton } from "@/components/ui/skeleton";
import {
  DetailHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  ChartSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

/** Matches /creator-hub/codes-ads/codes/[code] detail layout. */
export default function CreatorHubCodeDetailLoading() {
  return (
    <div className="space-y-6">
      <DetailHeroSkeleton />
      <KpiStripSkeleton count={7} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <ChartSkeleton height={300} />
        </div>
        <Skeleton className="h-72 rounded-2xl" />
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={100} />
        <TableSkeleton rows={10} columns={7} />
      </div>
    </div>
  );
}
