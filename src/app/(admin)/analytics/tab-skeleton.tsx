import { SkeletonKpiStrip, SkeletonChart } from "@/components/ux";

/**
 * Shared Suspense fallback for a tab panel. Every tab uses the same footprint
 * so switching feels instant while the new segment loads.
 *
 * Uses the layout-matching primitives — a KPI strip silhouette over a
 * chart-card silhouette — so the loading state reads as "KPIs + a chart
 * are coming" (the dominant tab shape) instead of flat grey boxes, and the
 * swap into real content stays dimension-stable.
 */
export function TabSkeleton() {
  return (
    <div className="space-y-4">
      <SkeletonKpiStrip count={6} />
      <SkeletonChart height={384} variant="area" />
    </div>
  );
}
