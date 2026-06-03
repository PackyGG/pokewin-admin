import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Layout-matching skeletons for the /packs catalog grid.
 *
 * These mirror <PacksGrid> / <PackTile> 1:1 so the loading → data swap
 * never shifts: same responsive column counts (1 → 2 → 3 → 4 → 5), same
 * gap, and the same per-tile anatomy — image + name/price header, a
 * four-metric stats row under a top border, and the mini card-preview
 * strip below it. A flat aspect-ratio box (the old fallback) was the
 * wrong shape: pack tiles are short, wide info cards, not card-shaped.
 *
 * Shimmer + reduced-motion are inherited from the base <Skeleton>.
 * Used by both packs/loading.tsx and the page's inline <Suspense>
 * fallback so the two stay in lockstep.
 */

/** Single pack tile placeholder — matches <PackTile> structure exactly. */
export function PackTileSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border bg-card/50">
      {/* Header: image + name/price */}
      <div className="flex items-start gap-3 p-3 pr-10">
        <Skeleton className="size-12 shrink-0 rounded-lg" />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <Skeleton className="h-3.5 w-24 rounded" />
            <Skeleton className="h-5 w-12 shrink-0 rounded-md" />
          </div>
          <Skeleton className="h-2.5 w-20 rounded" />
        </div>
      </div>

      {/* Stats row — four compact metrics under a top border. */}
      <div className="grid grid-cols-4 gap-1 border-t bg-muted/20 px-3 py-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-1">
            <Skeleton className="h-2 w-10 rounded" />
            <Skeleton className="h-3 w-8 rounded" />
          </div>
        ))}
      </div>

      {/* Mini card preview strip. */}
      <div className="flex items-center gap-1 px-3 pb-3 pt-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="size-6 shrink-0 rounded-sm" />
        ))}
      </div>
    </div>
  );
}

/**
 * Responsive grid of pack tiles. Column counts + gap mirror <PacksGrid>
 * (1 → 2 → 3 → 4 → 5). Default count fills ~4 rows at the lg/xl density.
 */
export function PackGridSkeleton({
  count = 20,
  className,
}: {
  count?: number;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid gap-3",
        "grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5",
        className,
      )}
    >
      {Array.from({ length: count }).map((_, i) => (
        <PackTileSkeleton key={i} />
      ))}
    </div>
  );
}
