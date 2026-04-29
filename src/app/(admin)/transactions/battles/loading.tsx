import {
  PageHeroSkeleton,
  TabBarSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/** Matches /transactions/battles: hero, status tabs, search, table. */
export default function BattleTransactionsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="space-y-4">
        <TabBarSkeleton count={4} />
        <ToolbarSkeleton filters={0} />
        <TableSkeleton rows={15} columns={7} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
