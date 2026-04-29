import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  ChartRowSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /creators/analytics: hero with period filter, 7 stat cards
 * (Signups / Commission / Wager / Deposits / Clicks / Conversion /
 * Active Creators) in a 3-col grid, and a daily-trend charts row.
 */
export default function CreatorAnalyticsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <KpiStripSkeleton count={7} />
      <ChartRowSkeleton count={2} height={300} />
    </div>
  );
}
