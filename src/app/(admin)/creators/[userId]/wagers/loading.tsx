import {
  DetailHeroSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for /creators/[userId]/wagers — keeps the
 * shell visible on a cold navigation while the creator header + the recent
 * wager feed resolve.
 *
 * Mirrors the page chrome 1:1: the detail hero (back button + avatar +
 * name/code + subtitle), the 2-tab code-activity pill nav, the section
 * heading, then the 4-column wagers table inside its `rounded-2xl
 * bg-card/60` container — so nothing jumps when the data lands.
 */
export default function CreatorWagersLoading() {
  return (
    <div className="space-y-6">
      <DetailHeroSkeleton />

      {/* Code-activity pill nav — 2 tabs. */}
      <div className="inline-flex items-center gap-1 rounded-xl border bg-card/60 p-1">
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-32 rounded-lg" />
        ))}
      </div>

      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={160} />
        <WagerTableSkeleton />
      </div>
    </div>
  );
}

/**
 * The 4-column wagers table (User · Type · Amount · When) inside the
 * page's `rounded-2xl border bg-card/60` container, with stable-height
 * rows so the swap into the real table doesn't shift.
 */
function WagerTableSkeleton() {
  return (
    <div className="overflow-hidden rounded-2xl border bg-card/60">
      <div className="flex items-center gap-4 border-b px-4 py-3">
        <Skeleton className="h-4 w-16 rounded" />
        <Skeleton className="h-4 w-12 rounded" />
        <Skeleton className="ml-auto h-4 w-16 rounded" />
        <Skeleton className="h-4 w-16 rounded" />
      </div>
      <div className="divide-y">
        {Array.from({ length: 10 }).map((_, r) => (
          <div key={r} className="flex items-center gap-4 px-4 py-3">
            <Skeleton className="h-4 w-28 rounded" />
            <Skeleton className="h-5 w-20 rounded-md" />
            <Skeleton className="ml-auto h-4 w-16 rounded" />
            <Skeleton className="h-4 w-16 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}
