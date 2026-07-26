import {
  KpiStripSkeleton,
  PageHeroSkeleton,
  SectionHeadingSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function KenoLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <Skeleton className="h-10 w-full rounded-lg" />
      <KpiStripSkeleton count={6} />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={150} />
        <TableSkeleton rows={8} columns={6} />
      </div>
    </div>
  );
}
