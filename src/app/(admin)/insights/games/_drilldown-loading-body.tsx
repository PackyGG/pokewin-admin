import { Skeleton } from "@/components/ui/skeleton";
import { SkeletonText } from "@/components/ux";

/**
 * Shared loading body for the pack / battle drilldown popovers. Both
 * bodies open with a small metric strip (mode/pot/payout/P&L or
 * RTP/drift/volume) followed by a couple of short lists, so this
 * skeleton mirrors that shape — a 4-up metric strip over a few text
 * lines and a compact list — instead of a single "Loading…" line.
 *
 * Wrapped in a polite status region so a screen reader hears one
 * "Loading…" cue rather than a pile of empty boxes. Shimmer +
 * reduced-motion are inherited from the base `<Skeleton>`.
 */
export function DrilldownLoadingBody() {
  return (
    <div className="space-y-3" role="status" aria-busy="true">
      <span className="sr-only">Loading drilldown…</span>
      {/* Headline metric strip — 4 cells, matching the real strip. */}
      <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/40 p-2 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-1.5">
            <Skeleton className="h-2 w-10 rounded" />
            <Skeleton className="h-3.5 w-14 rounded" />
          </div>
        ))}
      </div>
      {/* A short label + a compact list of rows. */}
      <div className="space-y-1.5">
        <Skeleton className="h-2.5 w-24 rounded" />
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center justify-between gap-2">
            <SkeletonText lines={1} width="55%" size="sm" className="flex-1" />
            <Skeleton className="h-3 w-12 shrink-0 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}
