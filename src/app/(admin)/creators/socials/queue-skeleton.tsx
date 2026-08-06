import { Skeleton } from "@/components/ui/skeleton";

/**
 * The queue card placeholder, shared by the route-level `loading.tsx` (cold
 * navigation) and the page's own `<Suspense>` boundary (status / page flip)
 * so both states render the exact same shape — status-tab row + "showing N of
 * M" line, then submission rows (avatar + creator/handle + badges + actions).
 */
export function SocialsQueueCardSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      {/* Status tabs + "showing N of M". */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="inline-flex gap-1 rounded-lg border bg-muted/50 p-1">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-20 rounded-md" />
          ))}
        </div>
        <Skeleton className="h-3 w-28 rounded" />
      </div>

      {/* Submission rows. */}
      <ul className="mt-4 divide-y">
        {Array.from({ length: rows }).map((_, i) => (
          <li
            key={i}
            className="flex flex-col gap-3 py-4 md:flex-row md:items-center md:justify-between"
          >
            <div className="flex items-start gap-3">
              <Skeleton className="size-9 shrink-0 rounded-full" />
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <Skeleton className="h-4 w-32 rounded" />
                  <Skeleton className="h-4 w-14 rounded-md" />
                  <Skeleton className="h-4 w-16 rounded-md" />
                </div>
                <Skeleton className="h-3 w-48 rounded" />
                <Skeleton className="h-2.5 w-40 rounded" />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Skeleton className="h-8 w-20 rounded-md" />
              <Skeleton className="h-8 w-20 rounded-md" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
