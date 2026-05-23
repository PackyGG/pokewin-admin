import {
  PageHeroSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
  PaginationSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";

/** Matches /transactions/deposits: hero, search toolbar, deposits table section. */
export default function DepositsTransactionsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="space-y-4">
        <ToolbarSkeleton filters={0} />
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={120} />
        <TableSkeleton rows={15} columns={6} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
