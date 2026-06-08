import { Skeleton } from "@/components/ui/skeleton";
import { PageHeroSkeleton } from "@/components/loading-skeletons";

export function EdgePlanV2Skeleton() {
  return (
    <div className="space-y-4">
      <PageHeroSkeleton />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-[88px] rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-[420px] rounded-xl" />
    </div>
  );
}

export default EdgePlanV2Skeleton;
