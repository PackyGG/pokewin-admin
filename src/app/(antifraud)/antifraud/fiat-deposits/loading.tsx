import {
  PaginationSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function FiatDepositReviewsLoading() {
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Skeleton className="h-8 w-full" />
        <TableSkeleton rows={12} columns={6} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
