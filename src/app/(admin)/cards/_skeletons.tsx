import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Layout-matching skeletons for the /cards catalog grid.
 *
 * Mirrors <CardTile> (the shared tile used by both the cards grid and the
 * pack-detail card grid) so the loading → data swap is shift-free: a thin
 * rarity accent line on top, a padded 5/7 image frame, then a footer with
 * the name row (rarity dot + label) and two sparse data rows. Grid column
 * counts + gap match <CardsGrid> exactly (2 → 3 → 5 → 7 → 10).
 *
 * Shimmer + reduced-motion are inherited from the base <Skeleton>. Used by
 * both cards/loading.tsx and the page's inline <Suspense> fallback so the
 * two stay in lockstep (they had drifted apart — different column counts
 * and aspect ratios — before this).
 */

/** Single card tile placeholder — matches <CardTile> structure exactly. */
export function CardTileSkeleton() {
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border bg-card/50">
      {/* Rarity accent line — a hair on top. */}
      <Skeleton className="h-0.5 w-full rounded-none" />

      {/* Image frame — padded inside the container, 5/7 aspect. */}
      <div className="px-2 pt-2">
        <Skeleton
          className="w-full rounded-lg"
          style={{ aspectRatio: "5 / 7" }}
        />
      </div>

      {/* Footer: name + rarity dot, then two sparse data rows. */}
      <div className="flex flex-col gap-1 px-2 py-1.5">
        <div className="flex items-center gap-1.5">
          <Skeleton className="size-1.5 shrink-0 rounded-full" />
          <Skeleton className="h-2.5 w-full max-w-[72px] rounded" />
        </div>
        <div className="flex flex-col gap-1 pt-0.5">
          <div className="flex items-center justify-between gap-1">
            <Skeleton className="h-2 w-10 rounded" />
            <Skeleton className="h-2 w-8 rounded" />
          </div>
          <div className="flex items-center justify-between gap-1">
            <Skeleton className="h-2 w-8 rounded" />
            <Skeleton className="h-2 w-6 rounded" />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Responsive grid of card tiles. Column counts + gap mirror <CardsGrid>
 * (2 → 3 → 5 → 7 → 10). Default count matches the page's 40-per-page
 * density (4 rows at xl).
 */
export function CardGridSkeleton({
  count = 40,
  className,
}: {
  count?: number;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid gap-2.5",
        "grid-cols-2 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-7 xl:grid-cols-10",
        className,
      )}
    >
      {Array.from({ length: count }).map((_, i) => (
        <CardTileSkeleton key={i} />
      ))}
    </div>
  );
}
