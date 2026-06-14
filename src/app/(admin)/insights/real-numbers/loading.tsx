import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { SkeletonText } from "@/components/ux";

/**
 * Route-level loading skeleton for /insights/real-numbers — keeps the
 * shell (PageHero) painted immediately while the Server Component resolves
 * its 9 heavy parallel reads (the lifetime cost-breakdown assembly, the
 * insights-hub wager, the per-game GGR split, the realized-P&L snapshot,
 * the reward-spend itemization, the creator-program legs, …). On the
 * lifetime window these are the heaviest queries in the admin, so a
 * layout-matching skeleton beats the previous blank screen.
 *
 * Mirrors the page chrome: hero (single-window — NO action slot, there is
 * no period filter), the 6-tile headline KPI strip, then the per-game GGR
 * split + the gaming-margin waterfall section silhouettes — using
 * layout-matching shapes so nothing jumps when the data lands.
 */
export default function RealNumbersLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />

      {/* Headline KPI strip (6 tiles) */}
      <KpiStripSkeleton count={6} />

      {/* Per-game GGR split table */}
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={240} />
        <div className="rounded-2xl border bg-card p-4 ring-1 ring-foreground/10 sm:p-5">
          <SkeletonText lines={5} />
        </div>
      </div>

      {/* Gaming-margin waterfall */}
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={280} />
        <div className="rounded-xl border bg-card p-3 ring-1 ring-foreground/10 sm:p-4">
          <SkeletonText lines={10} />
        </div>
      </div>

      {/* Reward & bonus spend — itemized */}
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={260} />
        <div className="rounded-2xl border bg-card p-4 ring-1 ring-foreground/10 sm:p-5">
          <SkeletonText lines={8} />
        </div>
      </div>

      {/* Balance-sheet P&L waterfall */}
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={220} />
        <div className="rounded-xl border bg-card p-3 ring-1 ring-foreground/10 sm:p-4">
          <Skeleton className="h-40 w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}
