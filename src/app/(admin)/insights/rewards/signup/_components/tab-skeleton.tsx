import {
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  ChartSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Default skeleton fallback for any in-progress tab on
 * /insights/rewards/signup. Covers the Overview / Retention / Funnel /
 * Time-to-claim / Hour-of-day / Country / etc. layouts since they share
 * the KPI strip + chart + side-by-side panel pattern.
 */
export function SignupInsightsTabSkeleton() {
  return (
    <div className="space-y-6">
      <KpiStripSkeleton count={6} />
      <ChartSkeleton height={320} title={false} />
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

/** Slightly shorter skeleton for tabs with a single panel + table. */
export function SignupInsightsCompactTabSkeleton() {
  return (
    <div className="space-y-6">
      <KpiStripSkeleton count={4} />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={200} />
        <TableSkeleton rows={10} columns={5} />
      </div>
    </div>
  );
}
