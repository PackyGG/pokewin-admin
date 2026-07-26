import {
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function FiatLoading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-16 w-full rounded-xl" />
      <Skeleton className="h-11 w-full rounded-lg" />
      <KpiStripSkeleton count={4} />
      <SectionHeadingSkeleton titleWidth={150} />
      <TableSkeleton rows={8} columns={6} />
    </div>
  );
}
