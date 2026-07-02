import {
  KpiStripSkeleton,
  PageHeroSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Retune V2 skeletons. `WorkspaceSkeleton` is THE one below-the-hero
 * skeleton — `page.tsx` imports it as its `<Suspense>` fallback and this
 * route-level loading state renders the SAME component under a hero
 * skeleton, so the two loading states can never drift (§3).
 *
 * Shape mirrors the real workspace: portfolio KPI strip (4 tiles) +
 * `[320px_1fr]` grid — a rail card with 10 two-line row placeholders and
 * the workspace column (KPI tiles + table).
 */
export function WorkspaceSkeleton() {
  return (
    <div className="space-y-4">
      <KpiStripSkeleton count={4} />
      <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        {/* Rail: sticky filter header + 10 two-line rows. */}
        <div className="hidden rounded-xl border bg-card lg:block">
          <div className="space-y-2 border-b p-2.5">
            <Skeleton className="h-8 w-full" />
            <div className="flex gap-1.5">
              <Skeleton className="h-5 w-20 rounded-full" />
              <Skeleton className="h-5 w-16 rounded-full" />
              <Skeleton className="h-5 w-14 rounded-full" />
            </div>
            <div className="flex gap-1.5">
              <Skeleton className="h-7 flex-1" />
              <Skeleton className="h-7 flex-1" />
            </div>
          </div>
          <div>
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className="space-y-1.5 border-b px-2.5 py-2 last:border-b-0">
                <div className="flex items-center gap-2">
                  <Skeleton className="size-3.5 rounded" />
                  <Skeleton className="h-4 flex-1" />
                  <Skeleton className="h-4 w-8" />
                </div>
                <div className="flex items-center gap-1.5 pl-[22px]">
                  <Skeleton className="h-3 w-12" />
                  <Skeleton className="h-3 w-6" />
                  <Skeleton className="size-1.5 rounded-full" />
                </div>
              </div>
            ))}
          </div>
        </div>
        {/* Mobile rail collapsible placeholder. */}
        <Skeleton className="h-10 rounded-xl lg:hidden" />
        {/* Workspace: plan KPI tiles + pool table. */}
        <div className="min-w-0 space-y-4">
          <div className="space-y-2">
            <Skeleton className="h-6 w-56" />
            <Skeleton className="h-4 w-40" />
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-20 rounded-xl" />
            ))}
          </div>
          <TableSkeleton rows={8} columns={5} />
        </div>
      </div>
    </div>
  );
}

/**
 * Route-level loading state for the Retune Workspace — the hero skeleton
 * plus the SAME `WorkspaceSkeleton` the page's Suspense fallback renders.
 */
export default function PackRetuneWorkspaceLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <WorkspaceSkeleton />
    </div>
  );
}
