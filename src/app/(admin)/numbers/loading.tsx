import {
  PageHeroSkeleton,
  KpiStripSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function NumbersLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="space-y-4">
        <Skeleton className="h-5 w-40" />
        <div className="grid max-w-2xl grid-cols-2 gap-3">
          <Skeleton className="h-20 rounded-xl" />
          <Skeleton className="h-20 rounded-xl" />
        </div>
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
      <KpiStripSkeleton count={5} />
      <div className="max-w-md space-y-4">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-72 w-full rounded-xl" />
      </div>
    </div>
  );
}
