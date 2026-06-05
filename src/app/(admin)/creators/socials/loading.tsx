import { PageHeroSkeleton } from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for /creators/socials — keeps the shell
 * visible on a cold navigation while the social-submission queue resolves
 * (a backend-API read that can be slow / unavailable).
 *
 * Mirrors the page chrome 1:1: the hero (with the trailing "Total in
 * queue" KPI tile reserved via the action slot), then the queue card —
 * the status-tab row + "showing N of M" line at the top, and the list of
 * submission rows (avatar + creator/handle + badges + actions) below.
 */
export default function CreatorSocialsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />

      <div className="rounded-xl border bg-card p-4">
        {/* Status tabs + "showing N of M". */}
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="inline-flex gap-1 rounded-lg bg-muted p-1">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-7 w-20 rounded-md" />
            ))}
          </div>
          <Skeleton className="h-3 w-28 rounded" />
        </div>

        {/* Submission rows. */}
        <ul className="mt-4 divide-y">
          {Array.from({ length: 6 }).map((_, i) => (
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
    </div>
  );
}
