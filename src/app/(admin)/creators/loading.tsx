import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  ToolbarSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /creators: hero, 7-tile KPI strip (Fill / Multiplier / Global
 * PnL / Converted / Leaderboard Cost / Active Deals / Live Now), search
 * toolbar, then the creator CARD GRID (1 / 2 / 3 cols) — not a table.
 * The card-shaped skeletons mirror CreatorCardGrid so nothing jumps when
 * the real cards swap in.
 */
export default function CreatorsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <KpiStripSkeleton count={7} />
      <div className="space-y-4">
        <ToolbarSkeleton filters={0} />
        <div className="grid gap-3 grid-cols-1 sm:gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-64 rounded-2xl" />
          ))}
        </div>
        <PaginationSkeleton />
      </div>
    </div>
  );
}
