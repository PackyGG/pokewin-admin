import { Skeleton } from "@/components/ui/skeleton";
import { SkeletonKpiStrip, SkeletonChart, SkeletonBoundary } from "@/components/ux";
import {
  PageHeroSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";
import { ChartRowSkeleton, UpgraderPanelSkeleton } from "./dashboard-skeletons";
import { DASHBOARD_PERIODS } from "@/lib/queries/dashboard-period";

/**
 * Full-page navigation skeleton for /dashboard — the entry surface (LCP).
 *
 * Mirrors page.tsx 1:1 so the route-transition skeleton and the in-page
 * Suspense fallbacks agree, and the real content swaps in with zero layout
 * shift:
 *   • PageHero (with the trailing Active-Rain + load-time action chips).
 *   • Period selector bar — one chip per entry in `DASHBOARD_PERIODS`
 *     (currently 9: 1h/3h/6h/12h/24h/3d/7d/30d/all), sourced from the same
 *     constant the real selector renders so the chip count never drifts.
 *   • Primary KPI strip (6 tiles) + secondary KPI strip (6 tiles).
 *   • Today-since-00:00 tiles — 4-up at xl, matches P&L / Reward / Creators /
 *     Chat Messages row in page.tsx.
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

      {/* Period selector bar — Clock label + chip row. Chip count is sourced
          from the canonical `DASHBOARD_PERIODS` constant so adding / removing
          a period chip never leaves the skeleton out of sync with the real
          selector. */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card/40 px-3 py-2">
        <Skeleton className="h-4 w-16 rounded" />
        <div className="flex items-center gap-1">
          {DASHBOARD_PERIODS.map((p) => (
            <Skeleton key={p} className="h-5 w-10 rounded" />
          ))}
        </div>
      </div>

      {/* KPI strips — 4-up primary period boxes (GGR · Wager [Total +
          Organic merged] · Deposits · Withdrawals) + 6-up secondary
          snapshot boxes (Total Users · FTDs · Depositors · Avg Deposit ·
          Deposits/Hour · Avg RTP · Avg P&L 7d). */}
      <SkeletonKpiStrip count={4} />
      <SkeletonKpiStrip count={8} />

      {/* Today-since-00:00 tiles — P&L · Reward · Creators · Chat. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4">
        <Skeleton className="h-[148px] w-full rounded-xl" />
        <Skeleton className="h-[148px] w-full rounded-xl" />
        <Skeleton className="h-[148px] w-full rounded-xl" />
        <Skeleton className="h-[148px] w-full rounded-xl" />
      </div>

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
