import { Skeleton } from "@/components/ui/skeleton";
import { SkeletonChart } from "@/components/ux";

export default function Analytics2Loading() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 border-b pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-9 w-72 max-w-full" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <Skeleton className="h-10 w-44" />
      </div>
      <Skeleton className="h-4 w-64" />
      <SkeletonChart height={390} variant="area" />
    </div>
  );
}
