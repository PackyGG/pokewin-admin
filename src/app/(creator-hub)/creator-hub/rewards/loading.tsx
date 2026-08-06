import { Crown } from "lucide-react";

import { SectionHeading } from "@/components/modern-panels";

/**
 * Skeleton for everything below the page identity: the 4-tile work-queue
 * strip, the Programs/Requests tab bar, the filter toolbar, and a few claim
 * rows.
 *
 * Each placeholder MIRRORS THE BOX MODEL of the thing it stands in for rather
 * than guessing a height — the tiles reuse `KpiTile`'s own
 * `rounded-lg border bg-card px-3 py-2.5 sm:px-4 sm:py-3` shell, the rows reuse
 * `Card`'s `rounded-2xl py-4 ring-1`. The old fixed `h-[92px] rounded-xl` /
 * `h-24 rounded-2xl` guesses were both the wrong radius and the wrong height,
 * so the layout jumped when the real content streamed in.
 *
 * Exported so `page.tsx` uses the exact same markup as its in-page Suspense
 * fallback — the route-level swap and the streamed swap look identical.
 */
export function RewardsBodySkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="rounded-lg border bg-card px-3 py-2.5 sm:px-4 sm:py-3"
          >
            <div className="flex items-center gap-1.5 sm:gap-2">
              <div className="size-3.5 shrink-0 animate-pulse rounded bg-muted sm:size-4" />
              <div className="h-4 w-20 animate-pulse rounded bg-muted" />
            </div>
            {/* text-xl/leading-tight → 25px, text-2xl → 30px at sm. */}
            <div className="mt-1.5 h-[25px] w-24 animate-pulse rounded bg-muted sm:h-[30px]" />
            <div className="mt-1 h-4 w-16 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>

      {/* Tab bar: p-1 shell + py-1.5 text-sm links → 40px, not 36. */}
      <div className="h-10 w-56 animate-pulse rounded-lg bg-muted" />

      {/* Filter toolbar — search box + program select, both h-9. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="h-9 w-full animate-pulse rounded-md bg-muted sm:w-64" />
        <div className="h-9 w-full animate-pulse rounded-md bg-muted sm:w-[220px]" />
      </div>

      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="rounded-2xl bg-card px-4 py-4 ring-1 ring-foreground/10"
          >
            <div className="flex items-start gap-3">
              <div className="size-10 shrink-0 animate-pulse rounded-full bg-muted" />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="h-5 w-48 max-w-full animate-pulse rounded bg-muted" />
                <div className="h-4 w-64 max-w-full animate-pulse rounded bg-muted" />
                <div className="h-4 w-40 max-w-full animate-pulse rounded bg-muted" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Route-level skeleton — the page identity (SectionHeading) is static, so it
 * renders for real; only the data-driven body is placeholdered, mirroring the
 * page's own Suspense fallback so navigating in and streaming look the same.
 */
export default function Loading() {
  return (
    <div className="space-y-6">
      <SectionHeading icon={Crown} title="Creator Rewards" />
      <RewardsBodySkeleton />
    </div>
  );
}
