import {
  PageHeroSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/** Matches /transactions/deposits: hero, search toolbar, deposits table. */
export default function DepositsTransactionsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="space-y-4">
        <ToolbarSkeleton filters={0} />
        <TableSkeleton rows={15} columns={6} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
