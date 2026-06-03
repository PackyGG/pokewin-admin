import { Skeleton } from "@/components/ui/skeleton";
import { SkeletonChart } from "@/components/ux";
import { cn } from "@/lib/utils";

/**
 * Dashboard-local skeleton composites.
 *
 * These mirror the dashboard's real surfaces 1:1 so the loading state holds
 * the exact dimensions the content will occupy — no layout shift (CLS) when
 * the streamed Server Components resolve, and no flat grey blocks that read
 * as "broken" instead of "loading".
 *
 * They build on the shared `SkeletonChart` atom (@/components/ux) and the base
 * `<Skeleton>` (shimmer + reduced-motion already baked in via globals.css), so
 * there's no bespoke animation here — everything inherits the app's centralized
 * motion treatment.
 *
 * The trend charts on the dashboard render inside `<Card>` (rounded-xl), so the
 * chart skeletons override `SkeletonChart`'s default rounded-2xl to rounded-xl
 * to match the real card radius and avoid a corner-radius pop on swap.
 */

/**
 * A row of N chart-card skeletons, laid out on the SAME responsive grid the
 * real trend rows use (`md:grid-cols-2 lg:grid-cols-3` for the 3-up rows).
 * Each cell is a `SkeletonChart` matched to the card chrome.
 */
export function ChartRowSkeleton({
  count = 3,
  height = 300,
  className,
}: {
  count?: number;
  height?: number;
  className?: string;
}) {
  const cols =
    count === 2
      ? "md:grid-cols-2"
      : count === 3
        ? "md:grid-cols-2 lg:grid-cols-3"
        : "md:grid-cols-2 xl:grid-cols-4";
  return (
    <div className={cn("grid gap-3 sm:gap-4", cols, className)}>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonChart key={i} height={height} className="rounded-xl" />
      ))}
    </div>
  );
}

/**
 * Skeleton for the Upgrader Stats panel — mirrors the real
 * `UpgraderStatsSection` layout exactly: cyan-tinted card chrome with corner
 * glows, a header strip (icon + title + scope chip), a 2-up hero row (House
 * P&L / House Edge), a 2-up volume row (Wager / Payouts), a 3-up activity row
 * (Bets / Avg Bet / Players), and the hit-rate band pinned to the bottom.
 *
 * `min-h-[400px]` + `h-full` keep it the same height as its 50/50 partner
 * (the Wager Attribution chart) so the paired row never jumps while one side
 * resolves ahead of the other.
 */
export function UpgraderPanelSkeleton() {
  return (
    <div className="surface-sheen relative h-full min-h-[400px] overflow-hidden rounded-xl ring-1 ring-inset ring-cyan-500/20 bg-gradient-to-br from-cyan-500/5 via-card to-card">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-12 -top-12 size-40 rounded-full bg-cyan-500/15 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -left-12 -bottom-12 size-40 rounded-full bg-cyan-500/10 blur-3xl"
      />
      <div className="relative flex h-full flex-col gap-3 p-3 sm:p-4">
        {/* Header — icon chip + title + scope chip */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <Skeleton className="size-8 shrink-0 rounded-lg" />
            <div className="space-y-1.5">
              <Skeleton className="h-3.5 w-28 rounded" />
              <Skeleton className="h-2.5 w-36 rounded" />
            </div>
          </div>
          <Skeleton className="h-5 w-16 shrink-0 rounded-full" />
        </div>

        {/* Hero row — House P&L / House Edge. Matches the real tiles'
            ring-1 edge + size-5 rounded-md icon chip so the swap is
            shift-free. */}
        <div className="grid grid-cols-2 gap-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <div
              key={i}
              className="rounded-xl bg-background/30 px-3 py-2.5 ring-1 ring-inset ring-border/60"
            >
              <div className="flex items-center gap-1.5">
                <Skeleton className="size-5 shrink-0 rounded-md" />
                <Skeleton className="h-2.5 w-16 rounded" />
              </div>
              <Skeleton className="mt-2 h-6 w-24 rounded" />
            </div>
          ))}
        </div>

        {/* Volume row — Wager / Payouts */}
        <div className="grid grid-cols-2 gap-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="rounded-xl border bg-background/40 px-3 py-2">
              <div className="flex items-center gap-1.5">
                <Skeleton className="size-5 shrink-0 rounded-md" />
                <Skeleton className="h-2.5 w-14 rounded" />
              </div>
              <Skeleton className="mt-1.5 h-4 w-20 rounded" />
            </div>
          ))}
        </div>

        {/* Activity row — Bets / Avg Bet / Players */}
        <div className="grid grid-cols-3 gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-lg border bg-background/30 px-2.5 py-1.5">
              <div className="flex items-center gap-1">
                <Skeleton className="size-3 shrink-0 rounded" />
                <Skeleton className="h-2.5 w-10 rounded" />
              </div>
              <Skeleton className="mt-1 h-4 w-12 rounded" />
            </div>
          ))}
        </div>

        {/* Hit-rate band — pinned to the bottom (mt-auto) */}
        <div className="mt-auto rounded-xl border bg-background/40 px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <Skeleton className="h-3 w-16 rounded" />
            <Skeleton className="h-4 w-12 rounded" />
          </div>
          <Skeleton className="mt-1.5 h-1.5 w-full rounded-full" />
          <div className="mt-1.5 flex items-center justify-between">
            <Skeleton className="h-3 w-16 rounded" />
            <Skeleton className="h-3 w-16 rounded" />
          </div>
        </div>
      </div>
    </div>
  );
}
