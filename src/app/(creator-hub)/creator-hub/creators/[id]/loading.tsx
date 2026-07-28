import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for `creators/[id]`. Mirrors the REAL layout:
 * an UNBOXED identity banner (the live `PageHero` is a plain wrapper — no
 * card box), the tab bar, then the first Overview rows — so a navigation
 * into a creator paints a stable shell instead of a blank flash while the
 * cheap header resolves.
 */
export default function CreatorDetailLoading() {
  return (
    <div className="space-y-5 sm:space-y-6">
      {/* Banner (unboxed — back arrow, avatar, name + badges, email, socials) */}
      <div className="flex items-start gap-2.5 sm:gap-3">
        <Skeleton className="size-9 rounded-md" />
        <Skeleton className="size-11 rounded-full sm:size-12" />
        <div className="flex-1 space-y-2">
          <div className="flex items-center gap-2">
            <Skeleton className="h-7 w-48" />
            <Skeleton className="h-5 w-20 rounded-md" />
            <Skeleton className="h-5 w-16 rounded-md" />
          </div>
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-7 w-56 rounded-md" />
        </div>
        <Skeleton className="h-8 w-28 rounded-md" />
      </div>

      {/* Tab bar */}
      <Skeleton className="h-11 w-full rounded-xl" />

      {/* KPI strip (KpiTile = rounded-lg) */}
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-[88px] rounded-lg" />
        ))}
      </div>

      {/* Deal | Leaderboards (Card = rounded-2xl) */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-56 rounded-2xl" />
        <Skeleton className="h-56 rounded-2xl" />
      </div>
    </div>
  );
}
