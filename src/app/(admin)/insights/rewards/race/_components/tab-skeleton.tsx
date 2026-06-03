import {
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  ChartSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { SkeletonChart } from "@/components/ux";

/**
 * Default skeleton fallback for any in-progress tab on
 * /insights/rewards/race. Generic enough for the Overview / Per-type /
 * ROI / Budget shapes (KPI strip + chart + side-by-side panels). The
 * side panels use the chart-card silhouette so the swap into real
 * content stays dimension-stable instead of jumping from a flat box.
 */
export function RaceInsightsTabSkeleton() {
  return (
    <div className="space-y-6">
      <KpiStripSkeleton count={6} />
      <ChartSkeleton height={280} title={false} />
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
    </div>
  );
}

/**
 * Slightly leaner skeleton for table-led tabs (Breakdown, Top Winners,
 * Repeat Winners) so the layout doesn't shift to a chart only to swap
 * back to a table.
 */
export function RaceInsightsTabTableSkeleton() {
  return (
    <div className="space-y-6">
      <KpiStripSkeleton count={4} />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={200} />
        <TableSkeleton rows={10} columns={6} />
      </div>
    </div>
  );
}
