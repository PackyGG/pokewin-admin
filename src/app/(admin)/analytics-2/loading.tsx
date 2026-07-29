import { Skeleton } from "@/components/ui/skeleton";
import { SkeletonChart, SkeletonKpiStrip } from "@/components/ux";

export default function Analytics2Loading() {
  return (
    <div className="space-y-5 sm:space-y-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 sm:mb-6 sm:gap-3">
        <div />
        <Skeleton className="h-9 w-40" />
      </div>
      <SkeletonKpiStrip count={3} className="sm:grid-cols-3" />
      <SkeletonChart height={300} variant="area" />
    </div>
  );
}
