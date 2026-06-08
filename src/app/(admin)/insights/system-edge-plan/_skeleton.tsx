/**
 * Loading skeleton for the System Edge Plan — mirrors the planner's layout
 * (profit hero + KPI strip + sticky nav + tab content) so the swap into
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

      {/* Overview-style 2-col chart grid */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="h-48 animate-pulse rounded-xl border bg-muted/30" />
        <div className="h-56 animate-pulse rounded-xl border bg-muted/30" />
        <div className="h-64 animate-pulse rounded-xl border bg-muted/30 md:col-span-2" />
        <div className="h-52 animate-pulse rounded-xl border bg-muted/30 md:col-span-2" />
      </div>
    </div>
  );
}
