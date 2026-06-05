import {
  PageHeroSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for /creators/changelog — keeps the shell
 * visible on a cold navigation while the active window's audit feed
 * resolves (admin-DB audit read + main-DB username resolution). The
 * in-page `<Suspense key={period}>` handles window swaps; this only
 * renders on the first paint of a cold nav.
 *
 * Mirrors the page chrome 1:1: the hero (with the period-filter action),
 * the 6-panel KPI strip (reproducing the page's own
 * `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6` breakpoints
 * and the `CreatorsKpiPanel` card shape), then the "Activity" heading + a
 * feed of audit rows.
 */
export default function CreatorChangelogLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />

      {/* KPI strip — 6 dashboard-style panel boxes. */}
      <div className="grid grid-cols-1 items-stretch gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 2xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="rounded-xl border bg-card p-4">
            <div className="flex items-center justify-between gap-2 pb-2">
              <Skeleton className="h-3 w-24 rounded" />
              <Skeleton className="size-4 shrink-0 rounded" />
            </div>
            <Skeleton className="h-7 w-16 rounded" />
            <Skeleton className="mt-2 h-3 w-28 rounded" />
          </div>
        ))}
      </div>

      {/* Activity feed. */}
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={120} />
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3"
            >
              <Skeleton className="size-8 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-1/2 rounded" />
                <Skeleton className="h-3 w-1/3 rounded" />
              </div>
              <Skeleton className="h-3 w-20 shrink-0 rounded" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
