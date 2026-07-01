import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  ChartRowSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /creators/analytics: hero with period filter, 7 stat cards
 * (Signups / Commission / Wager / Deposits / Clicks / Conversion /
 * Active Creators), and a daily-trend charts row.
 *
 * The KPI grid is pinned to the SAME responsive shape the real
 * <MetricTile> grid uses in page.tsx (`grid-cols-2 sm:grid-cols-3
 * lg:grid-cols-4` → two rows of 4 + 3 on lg). `KpiStripSkeleton`'s
 * count-based default for 7 tiles is a single `lg:grid-cols-7` row,
 * which would flip both the column count AND the height on stream-in
 * and on every period switch — a CLS jump. Overriding the grid here
 * keeps the skeleton 1:1 with the rendered grid so nothing shifts.
 */
export default function CreatorAnalyticsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <KpiStripSkeleton
        count={7}
        className="grid-cols-2 sm:grid-cols-3 lg:grid-cols-4"
      />
      <ChartRowSkeleton count={2} height={300} />
    </div>
  );
}
