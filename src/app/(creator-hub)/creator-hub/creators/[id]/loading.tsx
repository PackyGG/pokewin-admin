import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for `creators/[id]`. Mirrors the banner +
 * tab bar + first Overview rows so a navigation into a creator paints a
 * stable shell instead of a blank flash while the cheap header resolves.
 */
export default function CreatorDetailLoading() {
  return (
    <div className="space-y-5 sm:space-y-6">
      {/* Banner */}
      <div className="rounded-2xl border bg-card p-4 sm:rounded-3xl sm:p-5">
        <div className="flex items-start gap-3">
          <Skeleton className="size-9 rounded-md" />
          <Skeleton className="size-12 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-7 w-48" />
            <Skeleton className="h-4 w-40" />
            <div className="flex gap-2">
              <Skeleton className="h-7 w-24 rounded-lg" />
              <Skeleton className="h-7 w-24 rounded-lg" />
              <Skeleton className="h-7 w-28 rounded-lg" />
            </div>
          </div>
        </div>
      </div>

      {/* Tab bar */}
      <Skeleton className="h-11 w-full rounded-xl" />

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-[88px] rounded-xl" />
        ))}
      </div>

      {/* Deal | Leaderboards */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-56 rounded-xl" />
        <Skeleton className="h-56 rounded-xl" />
      </div>
    </div>
  );
}
