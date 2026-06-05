import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  StatPanelSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for /ggr — keeps the shell visible on a
 * cold navigation while the GGR breakdown resolves (the heaviest read is
 * the per-user top-contributor join). The in-page `<Suspense key={window}>`
 * handles window swaps; this only renders on the first paint of a cold nav.
 *
 * Mirrors the page chrome 1:1: the docked-rail right gutter, the hero
 * (with the window-switch + export action), the headline 6-tile KPI strip
 * + the 3-tile per-category wager strip, the three ledger-type card groups
 * (gaming / neutral / reward — 3 / 4 / 6 cards), the NGR panel, and the
 * top-contributors table — so nothing jumps when the data lands.
 */
export default function GgrLoading() {
  return (
    <div className="space-y-6 pr-10 xl:pr-12 2xl:pr-16">
      <PageHeroSkeleton action />

      <div className="space-y-3">
        <KpiStripSkeleton count={6} />
        <KpiStripSkeleton count={3} />
      </div>

      {/* Group 1 — Gaming payouts (3 cards). */}
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={180} />
        <LedgerCardGrid count={3} />
      </div>

      {/* Group 2 — Neutral conversions (note box + cards). */}
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={200} />
        <Skeleton className="h-12 w-full rounded-xl" />
        <LedgerCardGrid count={4} />
      </div>

      {/* Group 3 — Reward giveback (note box + cards). */}
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={180} />
        <Skeleton className="h-12 w-full rounded-xl" />
        <LedgerCardGrid count={6} />
      </div>

      {/* Net Gaming Revenue — a single wide stat panel. */}
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={200} />
        <StatPanelSkeleton rows={4} />
      </div>

      {/* Top contributors table. */}
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={220} />
        <TableSkeleton rows={10} columns={5} />
      </div>
    </div>
  );
}

/**
 * The per-ledger-type card grid — mirrors the page's own 1 / 2 / 3-col
 * responsive grid of bordered cards, so the swap into the real cards stays
 * dimension-stable.
 */
function LedgerCardGrid({ count }: { count: number }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="rounded-xl border bg-card p-4 sm:rounded-2xl sm:p-5"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 space-y-1.5">
              <Skeleton className="h-4 w-32 rounded" />
              <Skeleton className="h-3 w-20 rounded" />
            </div>
            <Skeleton className="h-4 w-14 rounded-md" />
          </div>
          <Skeleton className="mt-3 h-7 w-28 rounded" />
          <Skeleton className="mt-2 h-3 w-full rounded" />
          <Skeleton className="mt-1.5 h-3 w-5/6 rounded" />
          <div className="mt-3 flex items-center justify-between gap-3 border-t border-border/60 pt-2">
            <Skeleton className="h-3 w-20 rounded" />
            <Skeleton className="h-3 w-16 rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}
