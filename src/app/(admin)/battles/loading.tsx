import {
  PageHeroSkeleton,
  TabBarSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/** Matches /battles: hero, status tabs, search toolbar, battles table. */
export default function BattlesLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="space-y-4">
        <TabBarSkeleton count={5} />
        <ToolbarSkeleton filters={1} />
        <TableSkeleton rows={12} columns={7} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
