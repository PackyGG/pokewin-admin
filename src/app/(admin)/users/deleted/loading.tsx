import {
  DetailHeroSkeleton,
  SectionHeadingSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for /users/deleted — keeps the shell
 * visible on a cold navigation while the deleted-user snapshots (admin DB)
 * + the admin-username resolution resolve.
 *
 * Mirrors the page chrome 1:1: the detail hero (the page uses a
 * back-to-/users link, so the hero leads with a back chip), the 3-tile KPI
 * grid (recoverable / restored / retention — reproduced with the page's
 * own `grid-cols-1 md:grid-cols-3` breakpoints), then the "Recent
 * Snapshots" heading + the snapshots table — so nothing jumps.
 */
export default function DeletedUsersLoading() {
  return (
    <div className="space-y-6">
      <DetailHeroSkeleton />

      {/* KPI grid — matches the page's grid-cols-1 md:grid-cols-3. */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="rounded-xl border bg-card px-3 py-2.5 sm:px-4 sm:py-3"
          >
            <div className="flex items-center gap-1.5 sm:gap-2">
              <Skeleton className="size-3.5 rounded sm:size-4" />
              <Skeleton className="h-3 w-20 rounded sm:w-24" />
            </div>
            <Skeleton className="mt-1.5 h-5 w-16 rounded sm:mt-2 sm:h-6 sm:w-20" />
          </div>
        ))}
      </div>

      {/* Recent snapshots table. */}
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={160} />
        <TableSkeleton rows={10} columns={5} />
      </div>
    </div>
  );
}
