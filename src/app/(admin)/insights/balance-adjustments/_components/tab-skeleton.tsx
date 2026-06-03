import {
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  ChartSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { SkeletonChart } from "@/components/ux";

/**
 * Generic skeleton used while a Balance Adjustments tab streams in.
 *
 * Covers the common shape: top KPI strip + one main chart + two
 * side-by-side panels + a wide data table. Per-tab fallbacks fall back
 * to this so a flickering rerender doesn't expose a different placeholder
 * shape per tab. The side panels use the chart-card silhouette so the
 * loading state reads as content and the swap stays dimension-stable.
 */
export function BalanceAdjustmentTabSkeleton() {
  return (
    <div className="space-y-6">
      <KpiStripSkeleton count={6} />
      <ChartSkeleton height={320} title={false} />
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
        <TableSkeleton rows={8} columns={5} />
      </div>
    </div>
  );
}
