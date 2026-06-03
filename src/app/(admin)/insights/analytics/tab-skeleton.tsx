import { SkeletonKpiStrip, SkeletonChart } from "@/components/ux";

/**
 * Shared Suspense fallback for /insights/analytics tabs. Mirrors the
 * /analytics tab skeleton — same vertical rhythm so the switch feels
 * instant even when the underlying query is heavy.
 *
 * Layout-matching primitives: a 6-tile KPI strip silhouette over two
 * stacked chart-card silhouettes (the dominant overview/cohort/retention
 * shape), so the fallback reads as content and the swap stays
 * dimension-stable instead of jumping from flat boxes.
 */
export function InsightsTabSkeleton() {
  return (
    <div className="space-y-4">
      <SkeletonKpiStrip count={6} />
      <SkeletonChart height={320} variant="area" />
      <SkeletonChart height={320} variant="area" />
    </div>
  );
}
