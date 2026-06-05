import {
  PageHeroSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for the Insights hub (/insights).
 *
 * Mirrors the page chrome 1:1 so a cold navigation never jumps when the
 * content resolves: the hero (with the period-filter action), the
 * "Headline margin" section heading + the 6-tile KPI strip (the page's
 * only data fetch), then the "Drill in" heading + the quick-link grid.
 *
 * The headline strip reproduces the page's own 2 / 3 / 6-col responsive
 * grid and the tiles' 88px height; the quick-link grid reproduces the
 * 1 / 2 / 3 / 4-col grid and the link cards' icon + two-line layout.
 */
export default function InsightsHubLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />

      {/* Headline margin — the 6-tile KPI strip (page's only data fetch). */}
      <section className="space-y-3">
        <SectionHeadingSkeleton titleWidth={200} />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-[88px] rounded-xl border bg-card px-3 py-2.5 sm:px-4 sm:py-3"
            >
              <div className="flex items-center gap-1.5 sm:gap-2">
                <Skeleton className="size-3.5 rounded sm:size-4" />
                <Skeleton className="h-3 w-16 rounded sm:w-20" />
              </div>
              <Skeleton className="mt-1.5 h-5 w-20 rounded sm:mt-2 sm:h-6 sm:w-24" />
              <Skeleton className="mt-1.5 h-2.5 w-24 rounded" />
            </div>
          ))}
        </div>
      </section>

      {/* Drill in — the quick-link grid. */}
      <section className="space-y-3">
        <SectionHeadingSkeleton titleWidth={80} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="flex items-start gap-3 rounded-xl border bg-card p-4 ring-1 ring-foreground/10"
            >
              <Skeleton className="size-10 shrink-0 rounded-lg" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-32 rounded" />
                <Skeleton className="h-3 w-full rounded" />
                <Skeleton className="h-3 w-4/5 rounded" />
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
