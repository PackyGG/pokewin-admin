import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shared skeletons for the Socials Review queue — ONE source of truth used by
 * both the route-level `loading.tsx` and the in-page Suspense fallbacks, so
 * the placeholder always matches the real layout (avatar + name/chips lines
 * on the left, action buttons on the right, pager row at the bottom).
 */

function SocialsQueueRowsSkeleton({ rows = 5 }: { rows?: number }) {
  return (
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
  );
}

/** Rows + the pagination footer line — the whole streamed card body. */
export function SocialsQueueBodySkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div>
      <SocialsQueueRowsSkeleton rows={rows} />
      <div className="mt-4 flex items-center justify-between border-t pt-3">
        <Skeleton className="h-3 w-24 rounded" />
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-24 rounded-md" />
          <Skeleton className="h-3 w-8 rounded" />
          <Skeleton className="h-8 w-20 rounded-md" />
        </div>
      </div>
    </div>
  );
}

/** The status-tab chip strip (3 chips inside the bordered pill container). */
export function SocialsQueueTabsSkeleton() {
  return (
    <div className="flex items-center gap-0.5 rounded-lg border bg-muted/50 p-1">
      {Array.from({ length: 3 }).map((_, i) => (
        <Skeleton key={i} className="h-8 w-20 rounded-md" />
      ))}
    </div>
  );
}
