import {
  PageHeroSkeleton,
  TabBarSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /rewards/rakeback: hero, top-level Claims/Config tabs (default
 * Claims), nested rakeback-type tabs (All / Daily / Weekly / Monthly),
 * and a 6-column claims table (User / Type / Period / Wagered / Rakeback
 * / Claimed).
 */
export default function RakebackLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="space-y-4">
        <TabBarSkeleton count={2} />
        <TabBarSkeleton count={4} />
        <TableSkeleton rows={12} columns={6} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
