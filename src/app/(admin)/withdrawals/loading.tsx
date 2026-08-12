import {
  PageHeroSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
  PaginationSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Matches /withdrawals slot for slot so the swap-in is shift-free: hero, the
 * "Withdrawals" heading + its two-line description, the toolbar (search + 3
 * filters), then the "Withdrawal requests" heading and the table. The heading
 * block and the real 9-column table were both missing here, so the skeleton
 * reserved less height than the page and every load ended in a visible jump.
 */
export default function WithdrawalsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="space-y-1">
        <SectionHeadingSkeleton titleWidth={110} />
        <Skeleton className="h-4 w-full max-w-[420px]" />
      </div>
      <div className="space-y-4">
        <ToolbarSkeleton filters={3} />
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={140} />
        <TableSkeleton rows={12} columns={9} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
