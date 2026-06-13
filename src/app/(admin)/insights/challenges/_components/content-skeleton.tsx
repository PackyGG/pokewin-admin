import {
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  ChartSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

/**
 * Body skeleton for /insights/challenges — KPI strip + cost chart + table,
 * matching the real ChallengesContent layout 1:1 so nothing jumps on swap.
 */
export function ChallengesContentSkeleton() {
  return (
    <div className="space-y-6">
      <KpiStripSkeleton count={6} />
      <div className="rounded-2xl border bg-card p-4 sm:p-5">
        <SectionHeadingSkeleton />
        <div className="mt-3">
          <ChartSkeleton />
        </div>
      </div>
      <div className="rounded-2xl border bg-card p-4 sm:p-5">
        <SectionHeadingSkeleton />
        <div className="mt-3">
          <TableSkeleton rows={6} columns={7} />
        </div>
      </div>
    </div>
  );
}
