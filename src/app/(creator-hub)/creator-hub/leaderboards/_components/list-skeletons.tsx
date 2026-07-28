import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shared skeletons for the Live Leaderboards list — ONE source of truth used
 * by BOTH the route-level `loading.tsx` and the in-page Suspense fallbacks,
 * so the streamed shapes never drift from the route shell (the old
 * loading.tsx showed 4 KPI tiles while the page streams 5).
 */

/** Mirrors the 5-tile KPI strip (`grid-cols-2 sm:grid-cols-5`). */
export function LeaderboardsKpiSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-[88px] rounded-lg" />
      ))}
    </div>
  );
}

/** Mirrors the ranked row list (flat row cards). */
export function LeaderboardsRanklistSkeleton() {
  return (
    <div className="space-y-2.5">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-[80px] rounded-xl" />
      ))}
    </div>
  );
}

/**
 * Mirrors the real controls row (view chip group + compact sort select) so
 * the loading shell doesn't jump when the live controls mount.
 */
export function LeaderboardsControlsSkeleton() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Skeleton className="h-9 w-[248px] rounded-lg" />
      <Skeleton className="h-8 w-[160px] rounded-lg" />
    </div>
  );
}
