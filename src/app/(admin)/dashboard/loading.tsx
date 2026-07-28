import { SkeletonKpiStrip, SkeletonBoundary } from "@/components/ux";
import {
  PageHeroSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";
import { ChartRowSkeleton, TodayTileSkeleton } from "./dashboard-skeletons";

/**
 * Full-page navigation skeleton for /dashboard — the entry surface (LCP).
 *
 * Mirrors page.tsx 1:1 so the route-transition skeleton and the in-page
 * Suspense fallbacks agree, and the real content swaps in with zero layout
 * shift:
 *   • PageHero.
 *   • Today tiles — 4-up at xl: P&L Today · Reward + Creators Costs
 *     (merged) · Upgrader + Double Down (merged) · Fiat payments. This row
 *     renders FIRST (directly under the hero). All four now render as the
 *     same compact tile shape (owner request, 2026-07-02: merge Reward Costs
 *     + Creators Costs into one box, and Upgrader + Double Down into
 *     another, both "like deposits / withdrawals"), so all four reuse the
 *     same `TodayTileSkeleton` the in-page Suspense fallbacks use — the
 *     route skeleton and the streamed fallbacks agree exactly.
 *   • KPI strip (4 tiles: Wager [Total + Organic merged] · Deposits /
 *     Withdrawals [merged] · Crypto Fee · Keno).
 *   • Trends section: two 3-up chart rows (Wagers · Deposits · Signups &
 *     FTDs / Wager Attribution · Daily Cash P&L · Active Depositors).
 *
 * The former Upgrader Stats + Double Down 50/50 panel row (below the KPI
 * strip) is GONE — both panels merged into the Today-row tile above, so
 * there is no longer a skeleton for it here.
 *
 * The whole tree is wrapped in a SkeletonBoundary so assistive tech hears a
 * single polite "Loading dashboard…" instead of reading every shimmer box.
 */
export default function DashboardLoading() {
  return (
    <SkeletonBoundary label="Loading dashboard…" className="space-y-6">
      <PageHeroSkeleton />

      {/* Today tiles — P&L Today · Reward + Creators Costs (merged) ·
          Upgrader + Double Down (merged) + Fiat payments (4-up at xl). Rendered ABOVE the
          KPI strip to match page.tsx (which renders this row directly under
          the hero), so the real content swaps in with no layout shift. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4">
        <TodayTileSkeleton />
        <TodayTileSkeleton />
        <TodayTileSkeleton />
        <TodayTileSkeleton />
      </div>

      {/* KPI strip — 4-up period boxes (Wager [Total + Organic merged] ·
          Deposits/Withdrawals [merged] · Crypto Fee · Keno). */}
      <SkeletonKpiStrip
        count={4}
        className="sm:grid-cols-2 md:grid-cols-2 xl:grid-cols-4"
      />

      {/* Trends — two 3-up rows:
            Row 1: Wagers · Deposits · Signups & FTDs (merged).
            Row 2: Wager Attribution · Daily Cash P&L · Active Depositors.
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
