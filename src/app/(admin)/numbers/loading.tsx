import {
  PageHeroSkeleton,
  KpiStripSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function NumbersLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <KpiStripSkeleton count={5} />
      <div className="max-w-md space-y-4">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-72 w-full rounded-xl" />
      </div>
      <div className="max-w-2xl grid grid-cols-2 gap-3 md:grid-cols-3">
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-20 rounded-xl" />
      </div>
      <div className="max-w-md space-y-4">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-56 w-full rounded-xl" />
      </div>
      <div className="max-w-3xl space-y-4">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    </div>
  );
}
