import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { SkeletonBoundary } from "@/components/ux";
import { cn } from "@/lib/utils";

/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Entity-surface skeletons  (pokewin-admin · src/components/entity-surface)
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Layout-matched loading shells for the shared EntityTable + grid, so the
 * fallback → data swap is shift-free (no CLS). These mirror the real chrome:
 * the table skeleton reproduces the bordered card + sticky-header band + fixed
 * row height; the grid skeleton reproduces the responsive tile grid + the
 * CardTile aspect frame.
 *
 * Server-safe (no client hooks). Each is wrapped in `SkeletonBoundary` so a
 * screen reader hears a single "Loading…" rather than dozens of empty boxes.
 */

/**
 * Table skeleton dimension-matched to <EntityTable>: a header band followed by
 * `rows` body rows at a fixed height. The leading checkbox + first "entity"
 * cell (thumb + name) are reproduced so the header doesn't jump when data lands.
 */
export function EntityTableSkeleton({
  rows = 12,
  columns = 6,
  rowHeight = 48,
  selectable = true,
  leadingThumb = true,
  className,
}: {
  rows?: number;
  columns?: number;
  rowHeight?: number;
  selectable?: boolean;
  /** First cell renders a small square thumbnail + name (entity tables). */
  leadingThumb?: boolean;
  className?: string;
}) {
  const colWidths = ["w-24", "w-16", "w-20", "w-16", "w-20", "w-16", "w-20"];
  return (
    <SkeletonBoundary className={cn("overflow-hidden rounded-xl border bg-card", className)}>
      {/* Header band */}
      <div className="flex items-center gap-4 border-b bg-muted/60 px-3 py-3">
        {selectable && <Skeleton className="size-4 shrink-0 rounded-[4px]" />}
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton
            key={i}
            className={cn(
              "h-3.5 rounded",
              colWidths[i % colWidths.length],
              i === columns - 1 && "ml-auto",
            )}
          />
        ))}
      </div>
      {/* Body rows */}
      <div className="divide-y">
        {Array.from({ length: rows }).map((_, r) => (
          <div
            key={r}
            className="flex items-center gap-4 px-3"
            style={{ height: rowHeight }}
          >
            {selectable && <Skeleton className="size-4 shrink-0 rounded-[4px]" />}
            {leadingThumb ? (
              <div className="flex min-w-0 items-center gap-2">
                <Skeleton className="size-8 shrink-0 rounded-md" />
                <Skeleton className="h-3.5 w-28 rounded" />
              </div>
            ) : (
              <Skeleton className="h-3.5 w-24 rounded" />
            )}
            {Array.from({ length: columns - 1 }).map((_, c) => {
              const isLast = c === columns - 2;
              return (
                <Skeleton
                  key={c}
                  className={cn(
                    "h-3.5 rounded",
                    colWidths[(c + 1) % colWidths.length],
                    isLast && "ml-auto",
                  )}
                />
              );
            })}
          </div>
        ))}
      </div>
    </SkeletonBoundary>
  );
}

/**
 * Grid skeleton dimension-matched to a CardTile gallery — the responsive
 * 2→3→5→7→10 column grid with the 5/7 image aspect frame and a short name +
 * two data rows. `count` should match the page size so the height is right.
 */
export function EntityGridSkeleton({
  count = 20,
  className,
}: {
  count?: number;
  className?: string;
}) {
  return (
    <SkeletonBoundary
      className={cn(
        "grid gap-2.5 grid-cols-2 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-7 xl:grid-cols-10",
        className,
      )}
    >
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="flex flex-col overflow-hidden rounded-xl border bg-card/50"
        >
          <div className="h-0.5 w-full bg-muted" />
          <div className="px-2 pt-2">
            <Skeleton
              className="w-full rounded-lg"
              style={{ aspectRatio: "5 / 7" }}
            />
          </div>
          <div className="flex flex-col gap-1.5 px-2 py-1.5">
            <Skeleton className="h-3 w-4/5 rounded" />
            <Skeleton className="h-2.5 w-3/5 rounded" />
            <Skeleton className="h-2.5 w-full rounded" />
          </div>
        </div>
      ))}
    </SkeletonBoundary>
  );
}

/**
 * Filter-bar skeleton: a search box + a couple of pill-shaped filter controls
 * + a trailing view-toggle, matched to <FilterBar>'s controls row.
 */
export function FilterBarSkeleton({
  filters = 2,
  withTrailing = true,
  className,
}: {
  filters?: number;
  withTrailing?: boolean;
  className?: string;
}) {
  return (
    <SkeletonBoundary
      className={cn(
        "flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3",
        className,
      )}
    >
      <Skeleton className="h-9 w-full rounded-lg sm:max-w-sm sm:flex-1" />
      {Array.from({ length: filters }).map((_, i) => (
        <Skeleton key={i} className="h-9 w-[150px] rounded-lg" />
      ))}
      {withTrailing && (
        <Skeleton className="h-9 w-24 rounded-lg sm:ml-auto" />
      )}
    </SkeletonBoundary>
  );
}

/**
 * Pagination skeleton matched to <DataTablePagination>: a results count on the
 * left and a control cluster on the right.
 */
export function EntityPaginationSkeleton({ className }: { className?: string }) {
  return (
    <SkeletonBoundary
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-4",
        className,
      )}
    >
      <Skeleton className="h-4 w-24 rounded" />
      <div className="flex items-center gap-2">
        <Skeleton className="h-8 w-16 rounded-md" />
        <Skeleton className="h-8 w-28 rounded-md" />
        <Skeleton className="h-8 w-8 rounded-md" />
        <Skeleton className="h-8 w-8 rounded-md" />
      </div>
    </SkeletonBoundary>
  );
}
