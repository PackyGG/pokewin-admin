import { Skeleton } from "@/components/ui/skeleton";
import {
  PageTitleSkeleton,
  StatCardRowSkeleton,
} from "@/components/loading-skeletons";

export default function MapLoading() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <PageTitleSkeleton width={80} />
        <Skeleton className="h-9 w-[220px]" />
      </div>
      <StatCardRowSkeleton count={3} height={120} />
      {/* Actual world map is ~520px tall */}
      <Skeleton className="h-[560px] rounded-xl" />
    </div>
  );
}
