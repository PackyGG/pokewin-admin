import { Skeleton } from "@/components/ui/skeleton";

/**
 * Roster skeletons — ONE module shared by the route-level `loading.tsx` and
 * the in-page Suspense fallback, mirroring the real toolbar row and card
 * grid so the swap is layout-stable (no phantom hero — the page has none).
 */

/** Mirrors the toolbar row: [tabs] … [period] [search] [sort] [view] [add]. */
export function RosterToolbarSkeleton() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Skeleton className="h-9 w-64 rounded-lg" />
      <div className="flex w-full flex-wrap items-center gap-2 lg:ml-auto lg:w-auto">
        <Skeleton className="h-8 w-44 rounded-lg" />
        <Skeleton className="h-9 w-full rounded-md sm:w-56" />
        <Skeleton className="h-9 w-[180px] rounded-md" />
        <Skeleton className="h-9 w-[72px] rounded-lg" />
        <Skeleton className="h-9 w-28 rounded-md" />
      </div>
    </div>
  );
}

/** Mirrors the roster body: one meta line + the card grid. */
export function RosterListSkeleton() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-3 w-72 max-w-full" />
      <div className="grid grid-cols-1 gap-3 sm:gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-56 rounded-xl" />
        ))}
      </div>
    </div>
  );
}
