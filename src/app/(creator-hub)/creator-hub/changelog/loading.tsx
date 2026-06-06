import {
  PageHeroSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for the Creator Hub → Changelog page — keeps
 * the Hub chrome visible on a cold navigation while the active window's
 * audit feed resolves (admin-DB audit read + main-DB username resolution).
 * The in-page `<Suspense key={period}>` handles window swaps; this only
 * renders on the first paint of a cold nav.
 *
 * Mirrors the page chrome: the hero (with the period-selector action), the
 * 6 Hub KPI boxes (reproducing the page's
 * `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6` breakpoints
 * + the rounded-2xl box shape), then the "Activity" heading + a feed of
 * audit rows.
 */
export default function CreatorHubChangelogLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />

      {/* KPI strip — 6 Hub-style boxes. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-[104px] rounded-2xl" />
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
