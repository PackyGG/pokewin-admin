import {
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  ChartSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { SkeletonChart } from "@/components/ux";

/**
 * Default skeleton fallback for any in-progress tab on /insights/rewards.
 * Generic enough to fit the Overview / ROI / retention / forecast tabs
 * since they share the KPI strip + chart + table shape.
 *
 * Used inside `<Suspense fallback={...} key={tab}>` on the tabbed page so
 * tab swaps show a skeleton instead of stale numbers from the previous
 * tab. The side-by-side panels use the chart-card silhouette
 * (`SkeletonChart`) rather than flat grey boxes so the loading state reads
 * as "a panel is coming" and stays dimension-stable into the real content.
 */
export function InsightsRewardsTabSkeleton() {
  return (
    <div className="space-y-6">
      <KpiStripSkeleton count={6} />
      <ChartSkeleton height={340} title={false} />
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="space-y-3">
          <SectionHeadingSkeleton titleWidth={220} />
          <SkeletonChart height={256} variant="area" title={false} />
        </div>
        <div className="space-y-3">
          <SectionHeadingSkeleton titleWidth={220} />
          <SkeletonChart height={256} variant="area" title={false} />
        </div>
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={200} />
        <TableSkeleton rows={8} columns={4} />
      </div>
    </div>
  );
}

/**
 * Slightly shorter skeleton for category / stacking tabs that don't
 * lead with a chart — just a KPI strip + two side-by-side panels.
 */
export function InsightsRewardsCompactTabSkeleton() {
  return (
    <div className="space-y-6">
      <KpiStripSkeleton count={5} />
      <div className="grid gap-4 xl:grid-cols-2">
        <SkeletonChart height={320} variant="area" />
        <SkeletonChart height={320} variant="area" />
      </div>
    </div>
  );
}
