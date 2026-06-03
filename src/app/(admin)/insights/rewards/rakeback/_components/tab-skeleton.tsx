import {
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  ChartSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { SkeletonChart } from "@/components/ux";

/**
 * Default skeleton fallback for any in-progress tab on
 * /insights/rewards/rakeback. Generic enough to fit the Overview / Rate
 * / Cadence / ROI tabs since they share the KPI strip + chart + breakdown
 * shape. Used inside `<Suspense fallback={...} key={tab}>` on the tabbed
 * page so tab swaps show a skeleton instead of stale numbers. The
 * side-by-side panels use the chart-card silhouette so the loading state
 * reads as content and stays dimension-stable into the real panels.
 */
export function RakebackTabSkeleton() {
  return (
    <div className="space-y-6">
      <KpiStripSkeleton count={6} />
      <ChartSkeleton height={300} title={false} />
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
