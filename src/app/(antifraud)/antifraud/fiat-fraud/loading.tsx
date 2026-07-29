import {
  PageHeroSkeleton,
  PaginationSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function FiatFraudLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <Skeleton className="h-10 w-full" />
      <div className="space-y-3">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-full max-w-2xl" />
        <TableSkeleton rows={10} columns={7} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
