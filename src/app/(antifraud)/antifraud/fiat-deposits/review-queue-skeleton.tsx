import {
  PageHeroSkeleton,
  PaginationSkeleton,
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
 * Shape mirrors the real queue: the page hero, compact review workspaces,
 * and pagination row. Returned as a FRAGMENT so both call sites can drop it
 * straight into their own `space-y-3` stack and get the same rhythm the
 * real rows get.
 */
export function FiatDepositReviewsSkeleton() {
  return (
    <>
      <PageHeroSkeleton />
      <div className="space-y-4">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-80 rounded-xl xl:h-72" />
        ))}
      </div>
      <PaginationSkeleton />
    </>
  );
}
