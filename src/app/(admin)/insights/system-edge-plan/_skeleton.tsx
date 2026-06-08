/**
 * Loading skeleton for the System Edge Plan — mirrors the planner's layout
 * (profit hero + KPI strip + sticky nav + main/sidebar grid) so the swap into
 * real content doesn't jump. Pure markup, no client JS.
 */
export function SystemEdgePlanSkeleton() {
  return (
    <div className="space-y-6">
      {/* Config bar */}
      <div className="flex justify-between gap-3">
        <div className="h-5 w-32 animate-pulse rounded bg-muted/40" />
        <div className="h-9 w-48 animate-pulse rounded-lg border bg-muted/30" />
      </div>

      {/* Profit hero */}
      <div className="h-44 animate-pulse rounded-2xl border bg-muted/30 sm:rounded-3xl" />

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-20 animate-pulse rounded-xl border bg-muted/30" />
        ))}
      </div>

      {/* Section nav */}
      <div className="h-11 animate-pulse rounded-xl border bg-muted/30" />

      {/* Main + sidebar */}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
        <div className="space-y-5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-56 animate-pulse rounded-xl border bg-muted/30" />
          ))}
        </div>
        <div className="hidden space-y-5 xl:block">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-48 animate-pulse rounded-xl border bg-muted/30" />
          ))}
        </div>
      </div>
    </div>
  );
}
