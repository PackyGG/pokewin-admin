import { Skeleton } from "@/components/ui/skeleton";

/**
 * Body skeleton for the withdrawal review — the KPI strip, the two-column
 * evidence layout and the decision rail, at the real heights so the shell does
 * not jump when the monitor read resolves.
 *
 * ONE source, TWO consumers: `loading.tsx` (route-level navigation fallback)
 * and the page's own `<Suspense>` boundary. Keeping them identical is the point
 * — a mismatch is exactly what makes a streamed page flicker as it swaps from
 * the navigation fallback to the streaming one.
 */
export function WithdrawalReviewSkeleton() {
  return (
    <>
      <Skeleton className="h-24 rounded-xl" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-24 rounded-xl" />
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.7fr)]">
        <div className="min-w-0 space-y-6">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-40 rounded-xl" />
          ))}
        </div>
        <div className="min-w-0 space-y-5">
          <Skeleton className="h-72 rounded-xl" />
          <Skeleton className="h-56 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </div>
      </div>
    </>
  );
}
