/**
 * Loading skeleton for the System Edge Plan — mirrors the planner's layout
 * (profit hero + KPI strip + levers/breakdown two-column grid) so the swap into
 * real content doesn't jump. Pure markup, no client JS.
 */
export function SystemEdgePlanSkeleton() {
  return (
    <div className="space-y-6">
      {/* Profit hero */}
      <div className="h-44 animate-pulse rounded-2xl border bg-muted/30 sm:rounded-3xl" />

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-20 animate-pulse rounded-xl border bg-muted/30" />
        ))}
      </div>

      {/* Levers + breakdown */}
      <div className="grid gap-6 lg:grid-cols-[1.05fr_1fr]">
        {/* Levers column — many sectioned panels (edge / rakeback / deposit
            bonus / raffle / packs / rain / affiliate). */}
        <div className="space-y-5">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="h-48 animate-pulse rounded-xl border bg-muted/30" />
          ))}
        </div>
        {/* Breakdown column — GGR-by-type, cost chart, cost-delta table. */}
        <div className="space-y-5">
          <div className="h-56 animate-pulse rounded-xl border bg-muted/30" />
          <div className="h-80 animate-pulse rounded-xl border bg-muted/30" />
          <div className="h-72 animate-pulse rounded-xl border bg-muted/30" />
        </div>
      </div>
    </div>
  );
}
