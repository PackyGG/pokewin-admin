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
      <div className="space-y-4">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-72 w-full rounded-xl" />
      </div>
    </div>
  );
}
