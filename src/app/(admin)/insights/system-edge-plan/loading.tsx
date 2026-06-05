import { PageHeroSkeleton } from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { SystemEdgePlanSkeleton } from "./_skeleton";

/**
 * Route-level loading skeleton for /insights/system-edge-plan — keeps the
 * shell visible on a cold navigation while the selected period's baseline
 * resolves. The keyed `<Suspense>` in page.tsx handles post-mount period
 * swaps; this only renders on the first paint of a cold nav.
 *
 * Mirrors the page chrome: the hero (with the period-filter action), the
 * one-line anchoring note, then the planner island — reusing the page's
 * own `SystemEdgePlanSkeleton` (profit hero + KPI strip + levers/breakdown
 * two-column grid) so nothing jumps when the data lands.
 */
export default function SystemEdgePlanLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <Skeleton className="h-3 w-80 rounded" />
      <SystemEdgePlanSkeleton />
    </div>
  );
}
