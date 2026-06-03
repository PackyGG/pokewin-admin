import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Skeleton primitives  (pokewin-admin · src/components/ux)
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Atomic, dimension-matched skeleton building blocks. These are the LOW-LEVEL
 * pieces the whole app composes loading states from. The richer per-route
 * composites in `src/components/loading-skeletons.tsx` (PageHeroSkeleton,
 * TableSkeleton, …) build on the very same base `<Skeleton>` — these atoms
 * sit alongside them and are meant to be dropped inside cards, drawers, list
 * rows, tiles, etc.
 *
 * Shimmer + reduced-motion is inherited 100% from the base `<Skeleton>`
 * (`data-slot="skeleton"`): globals.css runs a soft shimmer sweep under
 * `prefers-reduced-motion: no-preference` and strips both the pulse and the
 * shimmer under `prefers-reduced-motion: reduce`. We add NOTHING that would
 * animate when motion is reduced.
 *
 * Every shell is `aria-hidden` and announces a polite "Loading…" to assistive
 * tech via the wrapper, so a screen reader hears one status, not dozens of
 * empty boxes.
 */

// ─── Loading wrapper (a11y) ─────────────────────────────────────────────────

/**
 * Wrap a block of skeletons so screen readers announce a single busy state
 * instead of reading each empty box. Visual-only skeletons stay `aria-hidden`.
 */
export function SkeletonBoundary({
  children,
  className,
  label = "Loading…",
}: {
  children: React.ReactNode;
  className?: string;
  /** Polite status text announced to assistive tech. */
  label?: string;
}) {
  return (
    <div className={className} role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div aria-hidden="true">{children}</div>
    </div>
  );
}

// ─── SkeletonText ───────────────────────────────────────────────────────────

/**
 * One or more text lines. The last line is shortened (like real wrapped
 * paragraphs) unless a single line is requested. Heights map to the app's
 * type scale so swapping in real text doesn't shift layout.
 *
 *   size: "xs" → 10px · "sm" → 12px · "base" → 14px · "lg" → 18px · "xl" → 24px
 */
export function SkeletonText({
  lines = 1,
  size = "base",
  width,
  lastLineWidth = "60%",
  className,
}: {
  /** Number of stacked lines. */
  lines?: number;
  size?: "xs" | "sm" | "base" | "lg" | "xl";
  /** Width of full lines (CSS length or %). Defaults to 100%. */
  width?: number | string;
  /** Width of the final line when `lines > 1`. */
  lastLineWidth?: number | string;
  className?: string;
}) {
  const h =
    size === "xs"
      ? "h-2.5"
      : size === "sm"
        ? "h-3"
        : size === "lg"
          ? "h-[18px]"
          : size === "xl"
            ? "h-6"
            : "h-3.5";
  return (
    <div className={cn("space-y-1.5", className)}>
      {Array.from({ length: lines }).map((_, i) => {
        const isLast = i === lines - 1 && lines > 1;
        return (
          <Skeleton
            key={i}
            className={cn(h, "rounded")}
            style={{ width: isLast ? lastLineWidth : (width ?? "100%") }}
          />
        );
      })}
    </div>
  );
}

// ─── SkeletonAvatar ─────────────────────────────────────────────────────────

/**
 * Round (default) or rounded-square avatar placeholder. Sizes match the app's
 * avatar usage: xs (size-6) up to xl (size-16). Optional trailing two-line
 * label block for "avatar + name/handle" rows.
 */
export function SkeletonAvatar({
  size = "md",
  shape = "circle",
  withLabel = false,
  className,
}: {
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  shape?: "circle" | "square";
  /** Render a name + subtext block to the right of the avatar. */
  withLabel?: boolean;
  className?: string;
}) {
  const dim =
    size === "xs"
      ? "size-6"
      : size === "sm"
        ? "size-8"
        : size === "lg"
          ? "size-12"
          : size === "xl"
            ? "size-16"
            : "size-10";
  const radius = shape === "square" ? "rounded-lg" : "rounded-full";
  if (!withLabel) {
    return <Skeleton className={cn(dim, radius, "shrink-0", className)} />;
  }
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <Skeleton className={cn(dim, radius, "shrink-0")} />
      <div className="min-w-0 space-y-1.5">
        <Skeleton className="h-3.5 w-28 rounded" />
        <Skeleton className="h-3 w-20 rounded" />
      </div>
    </div>
  );
}

// ─── SkeletonCard ───────────────────────────────────────────────────────────

/**
 * Generic content card shell — bordered `bg-card` surface that matches the
 * app's standard card chrome (rounded-xl border). Optional header (icon +
 * title), body text lines, and a footer action row. Use anywhere a `<Card>`
 * with content is about to render.
 */
export function SkeletonCard({
  header = true,
  lines = 3,
  footer = false,
  className,
  children,
}: {
  /** Icon-chip + title row at the top. */
  header?: boolean;
  /** Number of body text lines (ignored when `children` is provided). */
  lines?: number;
  /** A trailing action button placeholder. */
  footer?: boolean;
  className?: string;
  /** Custom body instead of the default text lines. */
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("rounded-xl border bg-card p-4 sm:p-5", className)}>
      {header && (
        <div className="mb-3 flex items-center gap-2">
          <Skeleton className="size-7 shrink-0 rounded-lg" />
          <Skeleton className="h-4 w-28 rounded" />
        </div>
      )}
      {children ?? <SkeletonText lines={lines} />}
      {footer && (
        <div className="mt-4 flex items-center gap-2">
          <Skeleton className="h-9 w-24 rounded-md" />
          <Skeleton className="h-9 w-20 rounded-md" />
        </div>
      )}
    </div>
  );
}

// ─── SkeletonKpiTile ────────────────────────────────────────────────────────

/**
 * A single KPI tile placeholder, dimension-matched to `<KpiTile>` (rounded-xl
 * border, icon + label row, hero value line). Render several in a grid, or use
 * `<SkeletonKpiStrip>` for a ready-made responsive row.
 */
export function SkeletonKpiTile({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "rounded-xl border bg-card px-3 py-2.5 sm:px-4 sm:py-3",
        className,
      )}
    >
      <div className="flex items-center gap-1.5 sm:gap-2">
        <Skeleton className="size-3.5 rounded sm:size-4" />
        <Skeleton className="h-3 w-12 rounded sm:w-16" />
      </div>
      <Skeleton className="mt-1.5 h-5 w-16 rounded sm:mt-2 sm:h-6 sm:w-20" />
    </div>
  );
}

/**
 * Responsive strip of `SkeletonKpiTile`s. Column counts mirror the real KPI
 * grids used across the app (2 on mobile → up to 8 on lg).
 */
export function SkeletonKpiStrip({
  count = 4,
  className,
}: {
  count?: number;
  className?: string;
}) {
  const gridCols =
    count >= 8
      ? "grid-cols-2 md:grid-cols-4 lg:grid-cols-8"
      : count === 7
        ? "grid-cols-2 md:grid-cols-3 lg:grid-cols-7"
        : count >= 6
          ? "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6"
          : count === 5
            ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5"
            : count === 4
              ? "grid-cols-2 md:grid-cols-4"
              : count === 3
                ? "grid-cols-2 md:grid-cols-3"
                : "grid-cols-2";
  return (
    <div className={cn("grid gap-3", gridCols, className)}>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonKpiTile key={i} />
      ))}
    </div>
  );
}

// ─── SkeletonTable ──────────────────────────────────────────────────────────

/**
 * Table placeholder with a header row and body rows of STABLE height. Row
 * height is fixed (`h-[var]` via inline style) so the skeleton occupies the
 * exact vertical space the real rows will — no CLS when data swaps in.
 *
 * The first column leads with a small round avatar cell (the app's tables
 * almost always start with an entity avatar). Column widths vary slightly so
 * it reads like a real table, not a uniform grid.
 */
export function SkeletonTable({
  rows = 8,
  columns = 6,
  rowHeight = 52,
  leadingAvatar = true,
  className,
}: {
  rows?: number;
  columns?: number;
  /** Fixed px height per body row — keep equal to the real row height. */
  rowHeight?: number;
  /** First cell is a round avatar (entity tables). */
  leadingAvatar?: boolean;
  className?: string;
}) {
  const colWidths = [
    "w-16",
    "w-28",
    "w-20",
    "w-24",
    "w-16",
    "w-24",
    "w-20",
    "w-24",
  ];
  return (
    <div className={cn("overflow-hidden rounded-md border", className)}>
      <div className="border-b bg-muted/50 px-4 py-3">
        <div className="flex items-center gap-4">
          {Array.from({ length: columns }).map((_, i) => (
            <Skeleton
              key={i}
              className={cn(
                "h-4 rounded",
                colWidths[i % colWidths.length],
                i === columns - 1 && "ml-auto",
              )}
            />
          ))}
        </div>
      </div>
      <div className="divide-y">
        {Array.from({ length: rows }).map((_, r) => (
          <div
            key={r}
            className="flex items-center gap-4 px-4"
            style={{ height: rowHeight }}
          >
            {leadingAvatar && (
              <Skeleton className="size-7 shrink-0 rounded-full" />
            )}
            {Array.from({
              length: leadingAvatar ? columns - 1 : columns,
            }).map((_, c) => {
              const idx = leadingAvatar ? c + 1 : c;
              const isLast = c === (leadingAvatar ? columns - 2 : columns - 1);
              return (
                <Skeleton
                  key={c}
                  className={cn(
                    "h-4 rounded",
                    colWidths[idx % colWidths.length],
                    isLast && "ml-auto",
                  )}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── SkeletonChart ──────────────────────────────────────────────────────────

/**
 * Chart card placeholder. Renders a faux bar/area silhouette inside the
 * standard chart-card chrome (rounded-2xl, bg-card, soft corner glow) so the
 * loading state reads as "a chart is coming", not a flat grey block.
 *
 * The bar heights are static (not animated) — the shimmer on each bar provides
 * the only motion, and it's reduced-motion safe via the base Skeleton.
 */
export function SkeletonChart({
  height = 280,
  title = true,
  variant = "bars",
  className,
}: {
  height?: number;
  title?: boolean;
  /** "bars" → discrete bars · "area" → single wide silhouette block. */
  variant?: "bars" | "area";
  className?: string;
}) {
  const innerH = title ? height - 48 : height - 16;
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl border bg-card p-4",
        className,
      )}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-12 -top-12 size-32 rounded-full bg-blue-500/[0.06] blur-2xl"
      />
      {title && (
        <div className="relative mb-3 flex items-center gap-2">
          <Skeleton className="size-4 rounded" />
          <Skeleton className="h-4 w-24 rounded" />
        </div>
      )}
      {variant === "area" ? (
        <Skeleton
          className="relative w-full rounded-lg"
          style={{ height: innerH }}
        />
      ) : (
        <div
          className="relative flex items-end gap-1.5"
          style={{ height: innerH }}
        >
          {[40, 55, 35, 70, 50, 80, 45, 65, 55, 75, 40, 60].map((h, i) => (
            <Skeleton
              key={i}
              className="flex-1 rounded-t"
              style={{ height: `${h}%` }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
