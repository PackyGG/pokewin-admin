import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Shared skeleton composites for per-route loading.tsx files.
 *
 * Each helper here mirrors one piece of the modern panel system (PageHero,
 * SectionHeading, KpiTile, StatPanel, tables, charts, grids). Keeping them
 * in one place means every page's loading state matches the real layout
 * 1:1 — skeletons that don't match shape cause layout jank when the real
 * content swaps in.
 *
 * Conventions:
 *   - Heights / widths approximate the real component so there's no jump.
 *   - All skeletons rely on the shimmer already baked into <Skeleton/>.
 *   - Dark mode just works because we use bg-card / border / muted tokens.
 */

// ─── PageHero ─────────────────────────────────────────────────────────────

/**
 * Mirrors <PageHero> — gradient shell with soft corner glows, icon chip,
 * title line, subtitle line. Set `action` to reserve room for the trailing
 * button/filter that lives on the right side of the hero.
 */
export function PageHeroSkeleton({
  subtitle = true,
  action = false,
}: {
  /** Render a subtitle line under the title. Defaults to true. */
  subtitle?: boolean;
  /** Reserve trailing space for a hero-level button / filter. */
  action?: boolean;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/60">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 -top-24 size-72 rounded-full bg-blue-500/[0.06] blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -left-24 -bottom-24 size-72 rounded-full bg-purple-500/[0.06] blur-3xl"
      />
      <div className="relative p-5 md:p-6">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <Skeleton className="size-10 rounded-xl" />
            <div className="space-y-2">
              <Skeleton className="h-6 w-40" />
              {subtitle && <Skeleton className="h-4 w-64" />}
            </div>
          </div>
          {action && <Skeleton className="h-9 w-32 rounded-md" />}
        </div>
      </div>
    </div>
  );
}

// ─── KPI strip ────────────────────────────────────────────────────────────

/**
 * Mirrors a row of <KpiTile>s. Matches the real tiles' rounded-xl border,
 * subtle accent-free background, icon + label line, and value line.
 */
export function KpiStripSkeleton({
  count = 4,
  className,
}: {
  count?: number;
  className?: string;
}) {
  // Common responsive breakpoints used across the app — 2 cols on mobile,
  // then 3 / 4 / 5 / 6 / 8 depending on count. We extend up to 8 because
  // the pack detail page renders an 8-tile KPI strip on lg+ screens.
  const gridCols =
    count >= 8
      ? "grid-cols-2 md:grid-cols-4 lg:grid-cols-8"
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
        <div key={i} className="rounded-xl border bg-card px-4 py-3">
          <div className="flex items-center gap-2">
            <Skeleton className="size-4 rounded" />
            <Skeleton className="h-3 w-16" />
          </div>
          <Skeleton className="mt-2 h-6 w-20" />
        </div>
      ))}
    </div>
  );
}

// ─── Section heading ──────────────────────────────────────────────────────

/** Mirrors <SectionHeading> — icon chip + title line, optional trailing action. */
export function SectionHeadingSkeleton({
  action = false,
  titleWidth = 140,
}: {
  action?: boolean;
  titleWidth?: number;
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <Skeleton className="size-7 rounded-md" />
        <Skeleton className="h-5" style={{ width: titleWidth }} />
      </div>
      {action && <Skeleton className="h-8 w-24 rounded-md" />}
    </div>
  );
}

// ─── Detail page hero ─────────────────────────────────────────────────────

/**
 * Detail-page hero (e.g. /users/[id], /battles/[id], /packs/[id]).
 * Matches the back-button + icon chip + title / subtitle pattern used in
 * every detail view.
 */
export function DetailHeroSkeleton({
  kpis = 0,
  action = false,
}: {
  /** Optional inline KPI pills tucked into the hero. */
  kpis?: number;
  /** Reserve trailing space for a detail-level action button. */
  action?: boolean;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/60">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 -top-24 size-72 rounded-full bg-blue-500/[0.06] blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -left-24 -bottom-24 size-72 rounded-full bg-purple-500/[0.06] blur-3xl"
      />
      <div className="relative p-5 md:p-6">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <Skeleton className="size-9 rounded-md" />
            <Skeleton className="size-10 rounded-xl" />
            <div className="space-y-2">
              <Skeleton className="h-6 w-56" />
              <Skeleton className="h-4 w-40" />
            </div>
          </div>
          {action && <Skeleton className="h-9 w-28 rounded-md" />}
        </div>
        {kpis > 0 && (
          <div className="mt-4 grid gap-3 grid-cols-2 md:grid-cols-4">
            {Array.from({ length: kpis }).map((_, i) => (
              <Skeleton key={i} className="h-16 rounded-xl" />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Toolbar ──────────────────────────────────────────────────────────────

/** Mirrors the shared <DataTableToolbar> — search input + filter dropdowns. */
export function ToolbarSkeleton({
  filters = 2,
}: {
  filters?: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Skeleton className="h-9 w-[260px]" />
      {Array.from({ length: filters }).map((_, i) => (
        <Skeleton key={i} className="h-9 w-[120px]" />
      ))}
    </div>
  );
}

// ─── Tabs (muted pill bar) ────────────────────────────────────────────────

/** Mirrors the inline tab pills (e.g. /battles status tabs, /rewards type tabs). */
export function TabBarSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="flex gap-1 rounded-lg bg-muted p-1 w-fit">
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="h-7 w-20 rounded-md" />
      ))}
    </div>
  );
}

// ─── Table ────────────────────────────────────────────────────────────────

export function TableSkeleton({
  rows = 10,
  columns = 6,
}: {
  rows?: number;
  columns?: number;
}) {
  // Give each column a slightly different width so it doesn't look like a
  // monotonous grid — matches how real tables look.
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
    <div className="rounded-md border">
      <div className="border-b px-4 py-3 bg-muted/50">
        <div className="flex items-center gap-4">
          {Array.from({ length: columns }).map((_, i) => (
            <Skeleton
              key={i}
              className={cn(
                "h-4",
                colWidths[i % colWidths.length],
                i === columns - 1 && "ml-auto",
              )}
            />
          ))}
        </div>
      </div>
      <div className="divide-y">
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} className="px-4 py-3">
            <div className="flex items-center gap-4">
              <Skeleton className="size-7 rounded-full" />
              {Array.from({ length: columns - 1 }).map((_, c) => (
                <Skeleton
                  key={c}
                  className={cn(
                    "h-4",
                    colWidths[(c + 1) % colWidths.length],
                    c === columns - 2 && "ml-auto",
                  )}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Chart ────────────────────────────────────────────────────────────────

/**
 * Mirrors a chart card — rounded-2xl bg-card shell with a subtle corner
 * glow + a fake bar/line representation inside. Looks less flat than a
 * plain Skeleton rectangle.
 */
export function ChartSkeleton({
  height = 300,
  title = true,
}: {
  height?: number | string;
  title?: boolean;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border bg-card p-4">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-12 -top-12 size-32 rounded-full bg-blue-500/[0.06] blur-2xl"
      />
      {title && (
        <div className="relative mb-3 flex items-center gap-2">
          <Skeleton className="size-4 rounded" />
          <Skeleton className="h-4 w-24" />
        </div>
      )}
      <div
        className="relative flex items-end gap-1.5"
        style={{ height: typeof height === "number" ? height - 48 : height }}
      >
        {/* Fake bar chart — varying heights via tailwind classes so it
            actually looks like a chart rather than a flat block. */}
        {[40, 55, 35, 70, 50, 80, 45, 65, 55, 75, 40, 60].map((h, i) => (
          <Skeleton
            key={i}
            className="flex-1 rounded-t"
            style={{ height: `${h}%` }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Row of N chart cards, auto-laying out based on count.
 */
export function ChartRowSkeleton({
  count = 3,
  height = 300,
}: {
  count?: number;
  height?: number;
}) {
  const cols =
    count === 2
      ? "grid-cols-1 md:grid-cols-2"
      : count === 3
        ? "grid-cols-1 lg:grid-cols-3"
        : "grid-cols-1 md:grid-cols-2 lg:grid-cols-4";
  return (
    <div className={cn("grid gap-4", cols)}>
      {Array.from({ length: count }).map((_, i) => (
        <ChartSkeleton key={i} height={height} />
      ))}
    </div>
  );
}

// ─── Grid (packs / cards / rewards) ──────────────────────────────────────

/**
 * Generic card/tile grid — packs, cards, rewards, leaderboards, etc.
 *
 * aspect:
 *   - "card"   → 3/4 (trading-card shape, cards grid)
 *   - "tile"   → 4/3 (packs grid, reward tiles)
 *   - "square" → 1/1 (avatar grid, etc.)
 */
export function GridSkeleton({
  count = 12,
  cols,
  aspect = "card",
}: {
  count?: number;
  cols?: number;
  aspect?: "square" | "card" | "tile";
}) {
  const ratio =
    aspect === "card" ? "3/4" : aspect === "tile" ? "4/3" : "1/1";
  // Default density matches the app — dense for cards (~10/row xl), looser
  // for packs (~6/row xl). Caller can override via cols.
  const gridCols =
    cols === 6
      ? "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6"
      : cols === 4
        ? "grid-cols-2 sm:grid-cols-3 md:grid-cols-4"
        : cols === 10
          ? "grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10"
          : "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6";
  return (
    <div className={cn("grid gap-3", gridCols)}>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton
          key={i}
          className="rounded-lg"
          style={{ aspectRatio: ratio }}
        />
      ))}
    </div>
  );
}

// ─── Pagination ───────────────────────────────────────────────────────────

/** Mirrors the shared <DataTablePagination>. */
export function PaginationSkeleton() {
  return (
    <div className="flex items-center justify-between flex-wrap gap-2">
      <Skeleton className="h-4 w-48" />
      <div className="flex items-center gap-2">
        <Skeleton className="h-8 w-8 rounded-md" />
        <Skeleton className="h-8 w-8 rounded-md" />
        <Skeleton className="h-8 w-20 rounded-md" />
        <Skeleton className="h-8 w-8 rounded-md" />
        <Skeleton className="h-8 w-8 rounded-md" />
      </div>
    </div>
  );
}

// ─── StatPanel ────────────────────────────────────────────────────────────

/** Mirrors <StatPanel> — larger card with corner glow, icon chip, rows. */
export function StatPanelSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/80 p-5">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-12 -top-12 size-32 rounded-full bg-blue-500/[0.06] blur-2xl"
      />
      <div className="relative mb-3 flex items-center gap-2">
        <Skeleton className="size-7 rounded-lg" />
        <Skeleton className="h-3 w-28" />
      </div>
      <Skeleton className="h-8 w-32 mb-3" />
      <div className="space-y-2">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center justify-between">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Form card ────────────────────────────────────────────────────────────

export function FormCardSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="rounded-xl border p-6 space-y-4">
      <Skeleton className="h-5 w-32" />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
    </div>
  );
}

// ─── Back-compat (legacy helpers) ────────────────────────────────────────

/**
 * Older loading.tsx files use these. Kept as thin wrappers around the new
 * composites so they still look modern without a search-and-replace pass.
 */
export function PageTitleSkeleton({ width = 200 }: { width?: number }) {
  return <Skeleton className="h-8" style={{ width }} />;
}

export function StatCardRowSkeleton({
  count = 4,
}: {
  count?: number;
  /** @deprecated heights now come from KpiStripSkeleton */
  height?: number;
}) {
  return <KpiStripSkeleton count={count} />;
}

export function CardGridSkeleton({
  count = 8,
  aspect = "3/4",
}: {
  count?: number;
  aspect?: string;
}) {
  const kind =
    aspect === "3/4" ? "card" : aspect === "4/3" ? "tile" : "square";
  return <GridSkeleton count={count} aspect={kind} />;
}

export function DetailHeaderSkeleton() {
  return <DetailHeroSkeleton />;
}
