import {
  PageHeroSkeleton,
  TabBarSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/** Matches /rewards/leaderboards: hero, tabs (Standings/Tiers/History), table. */
export default function LeaderboardsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="space-y-4">
        <TabBarSkeleton count={3} />
        <ToolbarSkeleton filters={1} />
        <TableSkeleton rows={12} columns={6} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
