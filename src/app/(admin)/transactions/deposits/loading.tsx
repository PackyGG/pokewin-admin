import {
  PageHeroSkeleton,
  PaginationSkeleton,
  SectionHeadingSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function FiatDepositReviewsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <Skeleton className="h-40 w-full rounded-xl" />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={180} />
        <Skeleton className="h-8 w-full" />
        <TableSkeleton rows={12} columns={6} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
