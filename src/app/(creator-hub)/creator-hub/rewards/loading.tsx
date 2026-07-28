import { Crown } from "lucide-react";

import { SectionHeading } from "@/components/modern-panels";

/**
 * Skeleton for everything below the page identity: the 4-tile work-queue
 * strip, the Programs/Requests tab bar, and a few claim/program rows.
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
            className="h-[92px] animate-pulse rounded-xl border bg-muted/30"
          />
        ))}
      </div>
      <div className="h-9 w-56 animate-pulse rounded-lg bg-muted" />
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          className="h-24 animate-pulse rounded-2xl border bg-muted/30"
        />
      ))}
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
