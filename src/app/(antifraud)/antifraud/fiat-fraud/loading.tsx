import {
  PageHeroSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function FiatFraudLoading() {
  return (
    <div className="space-y-4">
      <PageHeroSkeleton />
      <Skeleton className="h-10 w-full rounded-xl" />
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Skeleton className="size-7 rounded-lg" />
          <Skeleton className="h-4 w-36" />
        </div>
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton key={index} className="h-72 w-full rounded-xl" />
        ))}
        <PaginationSkeleton />
      </div>
    </div>
  );
}
