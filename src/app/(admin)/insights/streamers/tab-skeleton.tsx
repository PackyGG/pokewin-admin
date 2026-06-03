import { SkeletonKpiStrip, SkeletonTable } from "@/components/ux";

/**
 * Shared tab loading skeleton. Each Suspense'd tab segment uses this
 * fallback so navigation between tabs stays responsive even while the
 * heavy aggregate query is in flight.
 *
 * The streamer tabs are KPI strip + ranked-creator table throughout, so
 * the fallback uses the layout-matching KPI strip + table silhouette
 * (stable row heights → no CLS) instead of a flat grey block.
 */
export function TabSkeleton() {
  return (
    <div className="space-y-4">
      <SkeletonKpiStrip count={4} />
      <SkeletonTable rows={8} columns={5} />
    </div>
  );
}
