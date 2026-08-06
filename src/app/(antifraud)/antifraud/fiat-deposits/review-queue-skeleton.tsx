import {
  PageHeroSkeleton,
  PaginationSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The ONE skeleton for the Fiat deposit review queue.
 *
 * It is rendered from two places that must never drift apart:
 *   • `loading.tsx` — the route-level fallback shown while the page's own
 *     shell (session gate + searchParams) resolves, and
 *   • the `<Suspense>` fallback inside `page.tsx` — shown while the queue
 *     itself streams in behind the already-painted shell.
 *
 * Shape mirrors the real queue 1:1: the (currently controls-only, hence
 * empty) page hero, the mobile card stack, the desktop table, and the
 * pagination row. Returned as a FRAGMENT so both call sites can drop it
 * straight into their own `space-y-3` stack and get the same rhythm the
 * real rows get.
 */
export function FiatDepositReviewsSkeleton() {
  return (
    <>
      <PageHeroSkeleton />
      <div className="space-y-3 lg:hidden">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-32 rounded-xl" />
        ))}
      </div>
      <div className="hidden lg:block">
        <TableSkeleton rows={12} columns={6} />
      </div>
      <PaginationSkeleton />
    </>
  );
}
