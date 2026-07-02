import { Skeleton } from "@/components/ui/skeleton";
import { SkeletonChart } from "@/components/ux";
import { cn } from "@/lib/utils";

/**
 * Dashboard-local skeleton composites.
 *
 * These mirror the dashboard's real surfaces 1:1 so the loading state holds
 * the exact dimensions the content will occupy â€” no layout shift (CLS) when
 * the streamed Server Components resolve, and no flat grey blocks that read
 * as "broken" instead of "loading".
 *
 * They build on the shared `SkeletonChart` atom (@/components/ux) and the base
 * `<Skeleton>` (shimmer + reduced-motion already baked in via globals.css), so
 * there's no bespoke animation here â€” everything inherits the app's centralized
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
 * Skeleton for ONE of the three Today-row tiles (P&L Today Â· Reward +
 * Creators Costs [merged] Â· Upgrader + Double Down [merged]) that sit
 * directly under the hero. Mirrors the real card chrome so the Suspense
 * fallback swaps in shift-free instead of a flat grey
 * block snapping into a dense card:
 *   â€¢ Header row â€” title bar + a small right-side badge/icon chip.
 *   â€¢ Hero number bar â€” the big stat value.
 *   â€¢ Two faux breakdown rows â€” the 2-up component chip grid the real cards
 *     render (Deposits/Withdrawals, cost lines, etc.).
 *
 * Fixed `h-[148px]` matches the real tile footprint (the same height the flat
 * fallback used) so the 1-upâ†’2-upâ†’3-up responsive grid never jumps when the
 * streamed tile resolves.
 */
export function TodayTileSkeleton() {
  return (
    <div className="h-[148px] w-full overflow-hidden rounded-xl border bg-card p-3 sm:p-4">
      <div className="flex h-full flex-col gap-3">
        {/* Header â€” title bar + right-side badge/icon chip. */}
        <div className="flex items-center justify-between gap-2">
          <Skeleton className="h-3.5 w-24 rounded" />
          <Skeleton className="size-6 shrink-0 rounded-md" />
        </div>

        {/* Hero number bar â€” the big stat value. */}
        <Skeleton className="h-7 w-32 rounded" />

        {/* Two faux breakdown rows â€” the 2-up component chip grid. Pinned to
            the bottom (mt-auto) so it aligns with the real card's chip row. */}
        <div className="mt-auto grid grid-cols-2 gap-1.5">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="rounded-md border bg-background/40 px-2 py-1.5">
              <Skeleton className="h-2.5 w-12 rounded" />
              <Skeleton className="mt-1.5 h-3 w-16 rounded" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
