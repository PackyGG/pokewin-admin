import {
  DetailHeaderSkeleton,
  StatCardRowSkeleton,
  ChartRowSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function CreatorDetailLoading() {
  return (
    <div className="space-y-6">
      <DetailHeaderSkeleton />
      <StatCardRowSkeleton count={4} height={120} />
      <Skeleton className="h-10 w-full max-w-md" />
      <ChartRowSkeleton count={2} height={260} />
    </div>
  );
}
