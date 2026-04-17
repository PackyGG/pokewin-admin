import {
  PageHeroSkeleton,
  TabBarSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/** Matches /rewards/rakeback: hero, Claims/Config tabs, tabbed table. */
export default function RakebackLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="space-y-4">
        <TabBarSkeleton count={2} />
        <TableSkeleton rows={12} columns={6} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
