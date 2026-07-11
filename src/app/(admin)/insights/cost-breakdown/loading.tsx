import {
  PageHeroSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { SkeletonText } from "@/components/ux";

/**
 * Route-level loading skeleton — keeps the shell visible while the
 * Server Component resolves the cost-breakdown aggregation (which fans
 * out to the canonical metric layer + the bridge terms + the contributor
 * sweep). On the lifetime window these are the heaviest queries, so a
 * skeleton beats a blank screen.
 *
 * Mirrors the rebuilt page chrome 1:1 — hero (with period-filter action),
 * the plain-language story-lead block, the four-move summary grid, and
 * the waterfall panel — using layout-matching silhouettes so nothing
 * jumps when the data lands.
 */
export default function Loading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />

      {/* Story lead */}
      <div className="overflow-hidden rounded-2xl border bg-card">
        <div className="flex items-center gap-3 border-b bg-muted/30 px-4 py-3 sm:px-5">
          <Skeleton className="size-8 shrink-0 rounded-lg" />
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-3 w-40" />
          </div>
        </div>
        <div className="p-4 sm:p-5">
          <SkeletonText lines={4} />
        </div>
      </div>

      {/* Four-move summary grid */}
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={220} />
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, g) => (
            <div key={g} className="space-y-2">
              <Skeleton className="h-4 w-32" />
              <div className="grid gap-3">
                <Skeleton className="h-[5.5rem] rounded-xl" />
                <Skeleton className="h-[5.5rem] rounded-xl" />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Waterfall */}
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={260} />
        <div className="rounded-xl border bg-card p-3 sm:p-4">
          <SkeletonText lines={12} />
        </div>
      </div>
    </div>
  );
}
