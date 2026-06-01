import {
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  ChartSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Default skeleton fallback for any in-progress tab on /insights/rewards.
 * Generic enough to fit the Overview / ROI / retention / forecast tabs
 * since they share the KPI strip + chart + table shape.
 *
 * Used inside `<Suspense fallback={...} key={tab}>` on the tabbed page so
 * tab swaps show a skeleton instead of stale numbers from the previous
 * tab.
 */
export function InsightsRewardsTabSkeleton() {
  return (
    <div className="space-y-6">
      <KpiStripSkeleton count={6} />
      <ChartSkeleton height={340} title={false} />
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
        <Skeleton className="h-80 rounded-2xl" />
        <Skeleton className="h-80 rounded-2xl" />
      </div>
    </div>
  );
}
