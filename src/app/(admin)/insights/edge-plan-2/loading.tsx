import { Skeleton } from "@/components/ui/skeleton";

/**
 * Skeleton for the reworked Edge Plan 2.0 planner. Mirrors the new hero
 * (two side-by-side stat panels: profit delta + edge waterfall), the 6-tile
 * KPI strip below it, and the lever-rail + workspace split underneath.
 */
export function EdgePlanV2Skeleton() {
  return (
    <div className="space-y-4">
      {/* Hero: two stat panels (profit delta + edge waterfall). */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Skeleton className="h-[208px] rounded-xl" />
        <Skeleton className="h-[208px] rounded-xl" />
      </div>

      {/* KPI strip (6 tiles). */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-[88px] rounded-xl" />
        ))}
      </div>

      {/* Lever rail + active workspace. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
        <Skeleton className="hidden h-[320px] rounded-xl lg:block" />
        <Skeleton className="h-[420px] rounded-xl" />
      </div>
    </div>
  );
}

export default EdgePlanV2Skeleton;
