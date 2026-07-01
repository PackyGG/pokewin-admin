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
 *   • Today-since-00:00 tiles — 4-up at xl, matches the P&L / Reward /
 *     Creators / Chat Messages row that page.tsx renders FIRST (directly
 *     under the hero).
 *   • Primary KPI strip (4 tiles) + secondary KPI snapshot strip (8 tiles).
 *   • Upgrader Stats panel + Wager Attribution chart (paired 50/50, min-h-400).
 *   • Trends section: two 3-up chart rows
 *     (Wagers · Deposits · Signups & FTDs / Daily P&L · Cash P&L · Depositors).
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

      {/* Today-since-00:00 tiles — P&L · Reward · Creators. Rendered
          ABOVE the KPI strips to match page.tsx (which renders this row
          directly under the hero), so the real content swaps in with no
          layout shift. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-3">
        <Skeleton className="h-[148px] w-full rounded-xl" />
        <Skeleton className="h-[148px] w-full rounded-xl" />
        <Skeleton className="h-[148px] w-full rounded-xl" />
      </div>

      {/* KPI strips — 4-up primary period boxes (GGR · Wager [Total +
          Organic merged] · Deposits · Withdrawals) + 8-up secondary
          snapshot boxes (Total Users · FTDs · Depositors · Avg Deposit ·
          Deposits/Hour · Avg RTP · Avg P&L 7d). */}
      <SkeletonKpiStrip count={4} />
      <SkeletonKpiStrip count={8} />

      {/* Upgrader Stats + Wager Attribution — paired 50/50 row. */}
      <div className="grid min-h-[400px] gap-3 sm:gap-4 lg:grid-cols-2 lg:items-stretch">
        <UpgraderPanelSkeleton />
        <SkeletonChart height={400} className="h-full min-h-[400px] rounded-xl" />
      </div>

      {/* Trends — two 3-up rows:
            Row 1: Wagers · Deposits · Signups & FTDs (merged).
            Row 2: Daily P&L · Daily Cash P&L · Active Depositors.
          The merged Signups & FTDs chart replaces the prior standalone
          FTDs card; Active Depositors now sits in row 2 instead of its
          own full-width row, keeping the grid as two clean 3-ups. */}
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={80} />
        <ChartRowSkeleton count={3} height={300} />
        <ChartRowSkeleton count={3} height={300} />
      </div>
    </SkeletonBoundary>
  );
}
