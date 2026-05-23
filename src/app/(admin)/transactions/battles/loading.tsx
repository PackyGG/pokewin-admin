import {
  PageHeroSkeleton,
  TabBarSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
  PaginationSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";

/** Matches /transactions/battles: hero, status tabs, search, table section. */
export default function BattleTransactionsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="space-y-4">
        <TabBarSkeleton count={4} />
        <ToolbarSkeleton filters={0} />
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={120} />
        <TableSkeleton rows={15} columns={7} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
