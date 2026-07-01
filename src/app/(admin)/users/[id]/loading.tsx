import { Skeleton } from "@/components/ui/skeleton";
import {
  KpiStripSkeleton,
  TabBarSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /users/[id]: simple back-link header (no full PageHero), large
 * hero KPI strip from UserViewModern (8 tiles: Total Value · P&L · Total
 * Depo · Total Withdrawn · Deposits · Withdrawals · Multiplier · House Edge),
 * segmented tab bar (7 tabs: Overview · Gaming · Finances · Rewards ·
 * Inventory · Affiliate · Account), and tabbed content (panels +
 * tables). Counts mirror the real UserViewModern strip + tab bar so the
 * swap-in is jank-free.
 */
export default function UserDetailLoading() {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Skeleton className="size-9 rounded-md" />
        <div className="space-y-1.5">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>

      {/* Modern user view: identity hero — gradient container with avatar
          (+ status dot), name line, and a row of status / role pills.
          Shaped to match the real UserViewModern header so the swap-in
          doesn't jump from a flat block to a populated hero. */}
      <div className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/60 p-4 sm:p-5">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-12 -top-12 size-32 rounded-full bg-blue-500/[0.06] blur-2xl"
        />
        <div className="relative flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <Skeleton className="size-12 shrink-0 rounded-full sm:size-14" />
            <div className="min-w-0 space-y-2">
              <Skeleton className="h-5 w-40 rounded sm:h-6 sm:w-56" />
              <div className="flex flex-wrap items-center gap-1.5">
                <Skeleton className="h-5 w-16 rounded-md" />
                <Skeleton className="h-5 w-20 rounded-md" />
                <Skeleton className="h-5 w-14 rounded-md" />
              </div>
            </div>
          </div>
          <Skeleton className="h-9 w-full max-w-[160px] rounded-md sm:w-32" />
        </div>
      </div>

      <KpiStripSkeleton count={8} />

      <TabBarSkeleton count={5} />

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-48 rounded-2xl" />
        <Skeleton className="h-48 rounded-2xl" />
        <Skeleton className="h-48 rounded-2xl" />
      </div>
      <Skeleton className="h-64 rounded-2xl" />
    </div>
  );
}
