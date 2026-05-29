import {
  PageHeroSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
  PaginationSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";

/** Matches /withdrawals: hero, toolbar (search + 3 filters), table section. */
export default function WithdrawalsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="space-y-4">
        <ToolbarSkeleton filters={3} />
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={140} />
        <TableSkeleton rows={12} columns={7} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
