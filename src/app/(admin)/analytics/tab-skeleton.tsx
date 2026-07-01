import { SkeletonKpiStrip, SkeletonChart } from "@/components/ux";
import { KpiStripSkeleton, TableSkeleton } from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Per-tab Suspense fallbacks. Analytics tabs are shaped very differently —
 * KPIs + chart (overview/map), a stack of horizontal bars (funnel), or a
 * data table (top/ltv/packs). A single one-size fallback made the swap into
 * real content jump the layout, so each tab picks the variant that matches
 * its real footprint (see `page.tsx`, which selects per `tab`).
 */

/**
 * KPI-strip silhouette over a chart-card silhouette — the shape of the
 * overview and map tabs (headline KPIs + a chart grid). Kept as the default
 * `TabSkeleton` so those tabs read as "KPIs + a chart are coming" and the
 * swap into real content stays dimension-stable.
 */
export function TabSkeleton() {
  return (
    <div className="space-y-4">
      <SkeletonKpiStrip count={6} />
      <SkeletonChart height={384} variant="area" />
    </div>
  );
}

/**
 * Funnel-tab fallback: the info banner + a card whose body is a stack of
 * horizontal bar rows (one per funnel step) — matching `FunnelBars` in
 * `tab-funnel.tsx`, which renders a label row over a full-width bar track
 * per step, then a 3-cell summary strip.
 */
export function TabSkeletonBars() {
  return (
    <div className="space-y-4">
      {/* Info banner (icon chip + two text lines). */}
      <div className="flex items-start gap-3 rounded-xl border bg-muted/20 p-4">
        <Skeleton className="size-7 shrink-0 rounded-md" />
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-full max-w-md" />
        </div>
      </div>

      {/* Card containing the funnel bars. */}
      <div className="rounded-xl border bg-card">
        <div className="flex flex-col gap-2 border-b p-4 sm:flex-row sm:items-center sm:justify-between">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-7 w-40 rounded-md" />
        </div>
        <div className="space-y-3 p-4">
          {/* Six step rows — matches the six-step acquisition funnel. */}
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="space-y-1">
              <div className="flex items-center justify-between">
                <Skeleton className="h-3 w-32" />
                <Skeleton className="h-3 w-16" />
              </div>
              <Skeleton className="h-7 w-full rounded-md sm:h-8" />
            </div>
          ))}
          {/* Bottom 3-cell summary strip. */}
          <div className="mt-4 grid gap-3 rounded-lg border bg-muted/20 p-3 sm:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="space-y-1.5">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-4 w-14" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Table-shaped fallback for the top-performers / LTV / packs tabs — a KPI
 * strip (those tabs lead with metric tiles) over a data-table silhouette,
 * so the swap into the real leaderboard/table doesn't jump.
 */
export function TabSkeletonTable() {
  return (
    <div className="space-y-4">
      <KpiStripSkeleton count={4} />
      <TableSkeleton rows={10} columns={6} />
    </div>
  );
}
