import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  ChartRowSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /dashboard: PageHero (with a trailing load-time chip), 6-tile
 * primary stats (PnL/GGR/Total Wager/Raw Wager/Deposits/Withdrawals),
 * 7-tile secondary stats (Total Users/FTDs/Depositors/Users Total
 * Balance/Avg Deposit/Deposits per Hour/Avg RTP), Trends section (3
 * charts), and a 2-column live feed (Recent Activity + Deposits). Tile
 * counts mirror the Suspense fallbacks in page.tsx so the full-page
 * navigation skeleton and the streamed in-page skeletons agree.
 */
export default function DashboardLoading() {
  return (
    <div className="space-y-6">
      {/* action reserves room for the hero's load-time chip so the right
          edge doesn't jump when it streams in. */}
      <PageHeroSkeleton action />
      <KpiStripSkeleton count={6} />
      <KpiStripSkeleton count={7} />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={80} />
        <ChartRowSkeleton count={3} height={300} />
        <ChartRowSkeleton count={2} height={300} />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="space-y-3">
          <SectionHeadingSkeleton titleWidth={140} />
          <Skeleton className="h-96 rounded-2xl" />
        </div>
        <div className="space-y-3">
          <SectionHeadingSkeleton titleWidth={100} />
          <Skeleton className="h-96 rounded-2xl" />
        </div>
      </div>
    </div>
  );
}
