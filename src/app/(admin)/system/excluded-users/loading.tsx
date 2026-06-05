import { PageHeroSkeleton } from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for /system/excluded-users — keeps the
 * shell visible on a cold navigation while the blacklist resolves.
 *
 * Mirrors the page chrome 1:1: the hero (no action — this page has no
 * filter control), the amber scope/access notice box, then the
 * `ExcludedUsersClient` body — the "Add a user to the blacklist" form
 * card (3-column input row) and the blacklist table card below it — so
 * nothing jumps when the data lands.
 */
export default function ExcludedUsersLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />

      {/* Scope / access notice box. */}
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
        <div className="flex items-start gap-2">
          <Skeleton className="mt-0.5 size-4 shrink-0 rounded" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3 w-full rounded" />
            <Skeleton className="h-3 w-4/5 rounded" />
          </div>
        </div>
      </div>

      {/* Add-to-blacklist form card. */}
      <div className="rounded-xl border bg-card p-4">
        <Skeleton className="mb-3 h-4 w-44 rounded" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div className="space-y-1.5">
            <Skeleton className="h-3 w-20 rounded" />
            <Skeleton className="h-9 w-full rounded-md" />
          </div>
          <div className="space-y-1.5">
            <Skeleton className="h-3 w-24 rounded" />
            <Skeleton className="h-9 w-full rounded-md" />
          </div>
          <Skeleton className="h-9 w-24 rounded-md" />
        </div>
      </div>

      {/* Blacklist table card. */}
      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="flex items-center gap-4 border-b px-4 py-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-4 w-24 rounded" />
          ))}
        </div>
        <div className="divide-y">
          {Array.from({ length: 6 }).map((_, r) => (
            <div key={r} className="flex items-center gap-4 px-4 py-3">
              {Array.from({ length: 4 }).map((_, c) => (
                <Skeleton key={c} className="h-4 w-24 rounded" />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
