import {
  PageHeroSkeleton,
  TabBarSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /rewards/leaderboards: hero, top-level tabs (Standings / Tiers /
 * History), nested race-type tabs (All / Daily / Weekly), search toolbar,
 * and the default Standings table (3 columns: Position / User / Wagered).
 */
export default function LeaderboardsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="space-y-4">
        <TabBarSkeleton count={3} />
        <TabBarSkeleton count={3} />
        <ToolbarSkeleton filters={0} />
        <TableSkeleton rows={12} columns={3} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
