import { Skeleton } from "@/components/ui/skeleton";
import { SkeletonKpiStrip, SkeletonChart, SkeletonBoundary } from "@/components/ux";
import {
  PageHeroSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";
import { ChartRowSkeleton, UpgraderPanelSkeleton } from "./dashboard-skeletons";

/**
 * Full-page navigation skeleton for /dashboard — the entry surface (LCP).
 *
 * Mirrors page.tsx 1:1 so the route-transition skeleton and the in-page
 * Suspense fallbacks agree, and the real content swaps in with zero layout
 * shift:
 *   • PageHero (with the trailing Active-Rain + load-time action chips).
 *   • Period selector bar.
 *   • Primary KPI strip (6 tiles) + secondary KPI strip (7 tiles).
 *   • Upgrader Stats panel + Wager Attribution chart (paired 50/50, min-h-400).
 *   • Trends section: two 3-up chart rows.
 *
 * The whole tree is wrapped in a SkeletonBoundary so assistive tech hears a
 * single polite "Loading dashboard…" instead of reading every shimmer box.
 */
export default function DashboardLoading() {
  return (
    <SkeletonBoundary label="Loading dashboard…" className="space-y-6">
      {/* `action` reserves room for the hero's Active-Rain + load-time chips
          so the right edge doesn't jump when they stream in. */}
      <PageHeroSkeleton action />

      {/* Period selector bar — Clock label + chip row. */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card/40 px-3 py-2">
        <Skeleton className="h-4 w-16 rounded" />
        <div className="flex items-center gap-1">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-5 w-10 rounded" />
          ))}
        </div>
      </div>

      {/* KPI strips — 6-up primary + 7-up secondary. */}
      <SkeletonKpiStrip count={6} />
      <SkeletonKpiStrip count={7} />

      {/* Upgrader Stats + Wager Attribution — paired 50/50 row. */}
      <div className="grid min-h-[400px] gap-3 sm:gap-4 lg:grid-cols-2 lg:items-stretch">
        <UpgraderPanelSkeleton />
        <SkeletonChart height={400} className="h-full min-h-[400px] rounded-xl" />
      </div>

      {/* Trends — two 3-up chart rows. */}
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={80} />
        <ChartRowSkeleton count={3} height={300} />
        <ChartRowSkeleton count={3} height={300} />
      </div>
    </SkeletonBoundary>
  );
}
