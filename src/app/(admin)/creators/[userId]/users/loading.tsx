import {
  DetailHeroSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for /creators/[userId]/users — keeps the
 * shell visible on a cold navigation while the creator header + the
 * code-referral list (+ code-hopper flags) resolve.
 *
 * Mirrors the page chrome 1:1: the detail hero (back button + avatar +
 * name/code + subtitle), the 2-tab code-activity pill nav, the section
 * heading (with its trailing summary action), then the 4-column referrals
 * table inside its `rounded-2xl bg-card/60` container — so nothing jumps
 * when the data lands.
 */
export default function CreatorUsersLoading() {
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
        <SectionHeadingSkeleton titleWidth={180} action />
        <CodeActivityTableSkeleton />
      </div>
    </div>
  );
}

/**
 * The 4-column code-activity table (User · Wagered · Commission · Last
 * activity) inside the page's `rounded-2xl border bg-card/60` container,
 * with stable-height rows so the swap into the real table doesn't shift.
 */
function CodeActivityTableSkeleton() {
  return (
    <div className="overflow-hidden rounded-2xl border bg-card/60">
      <div className="flex items-center gap-4 border-b px-4 py-3">
        <Skeleton className="h-4 w-16 rounded" />
        <Skeleton className="ml-auto h-4 w-20 rounded" />
        <Skeleton className="h-4 w-24 rounded" />
        <Skeleton className="h-4 w-24 rounded" />
      </div>
      <div className="divide-y">
        {Array.from({ length: 10 }).map((_, r) => (
          <div key={r} className="flex items-center gap-4 px-4 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <Skeleton className="h-4 w-28 rounded" />
            </div>
            <Skeleton className="ml-auto h-4 w-16 rounded" />
            <Skeleton className="h-4 w-20 rounded" />
            <Skeleton className="h-4 w-24 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}
