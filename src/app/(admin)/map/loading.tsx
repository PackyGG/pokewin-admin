import { Skeleton } from "@/components/ui/skeleton";
import {
  PageTitleSkeleton,
  StatCardRowSkeleton,
} from "@/components/loading-skeletons";

export default function MapLoading() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <PageTitleSkeleton width={180} />
        <div className="flex gap-2">
          <Skeleton className="h-9 w-[280px]" />
          <Skeleton className="h-9 w-[220px]" />
        </div>
      </div>
      <StatCardRowSkeleton count={4} height={96} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Skeleton className="lg:col-span-2 h-[560px] rounded-2xl" />
        <Skeleton className="h-[560px] rounded-2xl" />
      </div>
      <Skeleton className="h-[260px] rounded-2xl" />
    </div>
  );
}
