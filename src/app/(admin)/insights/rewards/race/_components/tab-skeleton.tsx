import {
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  ChartSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Default skeleton fallback for any in-progress tab on
 * /insights/rewards/race. Generic enough for the Overview / Per-type /
 * ROI / Budget shapes (KPI strip + chart + side-by-side panels).
 */
export function RaceInsightsTabSkeleton() {
  return (
    <div className="space-y-6">
      <KpiStripSkeleton count={6} />
      <ChartSkeleton height={280} title={false} />
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="space-y-3">
          <SectionHeadingSkeleton titleWidth={220} />
          <Skeleton className="h-64 rounded-2xl" />
        </div>
        <div className="space-y-3">
          <SectionHeadingSkeleton titleWidth={220} />
          <Skeleton className="h-64 rounded-2xl" />
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
