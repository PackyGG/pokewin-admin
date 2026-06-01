import {
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  ChartSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Default skeleton for /insights/rewards/affiliate tab swaps. KPI strip
 * + chart + table — generic enough to fit Overview, Top, Cohort, Code
 * funnel, etc.
 */
export function AffiliateInsightsTabSkeleton() {
  return (
    <div className="space-y-6">
      <KpiStripSkeleton count={5} />
      <ChartSkeleton height={320} title={false} />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={220} />
        <TableSkeleton rows={8} columns={5} />
      </div>
    </div>
  );
}

/**
 * Compact variant for tabs without a chart — just KPIs + a single
 * panel (Inactive / Cadence / Code-switch use this).
 */
export function AffiliateInsightsCompactSkeleton() {
  return (
    <div className="space-y-6">
      <KpiStripSkeleton count={4} />
      <Skeleton className="h-96 rounded-2xl" />
    </div>
  );
}
