import { Skeleton } from "@/components/ui/skeleton";
import { PageHeroSkeleton } from "@/components/loading-skeletons";

/**
 * Route-level loading state for /marketing/giveaway. The page itself
 * awaits both the feed + totals at the top level (no inner Suspense),
 * so without this file a navigation would block on those queries and
 * leave the previous page on screen. This mirrors the real layout:
 * hero, a 2-tile KPI row (Total Giveaways / Total Value), then the
 * 3-up card grid of giveaway entries.
 */
export default function GiveawayLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />

      {/* KPI row — exactly 2 tiles, matching the page's grid-cols-2. */}
      <div className="grid grid-cols-2 gap-3">
        {Array.from({ length: 2 }).map((_, i) => (
          <div
            key={i}
            className="rounded-xl border bg-card px-3 py-2.5 sm:px-4 sm:py-3"
          >
            <div className="flex items-center gap-1.5 sm:gap-2">
              <Skeleton className="size-3.5 rounded sm:size-4" />
              <Skeleton className="h-3 w-20 rounded sm:w-28" />
            </div>
            <Skeleton className="mt-1.5 h-5 w-16 rounded sm:mt-2 sm:h-6 sm:w-24" />
          </div>
        ))}
      </div>

      {/* Card grid — same sm:grid-cols-2 xl:grid-cols-3 as the feed.
          Each shell matches a GiveawayCardView: avatar+name / amount
          header, a source-link chip, and an admin+date footer row. */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 9 }).map((_, i) => (
          <div
            key={i}
            className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <Skeleton className="size-8 shrink-0 rounded-full" />
                <div className="min-w-0 space-y-1.5">
                  <Skeleton className="h-3.5 w-24 rounded" />
                  <Skeleton className="h-2.5 w-20 rounded" />
                </div>
              </div>
              <div className="shrink-0 space-y-1.5 text-right">
                <Skeleton className="ml-auto h-4 w-14 rounded" />
                <Skeleton className="ml-auto h-2.5 w-12 rounded" />
              </div>
            </div>
            <Skeleton className="h-6 w-28 rounded-md" />
            <div className="flex items-center justify-between gap-2 border-t border-border/40 pt-2">
              <Skeleton className="h-2.5 w-20 rounded" />
              <Skeleton className="h-2.5 w-24 rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
