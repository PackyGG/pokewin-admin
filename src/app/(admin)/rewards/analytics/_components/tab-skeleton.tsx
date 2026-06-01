import {
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  ChartSkeleton,
  StatPanelSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Fallback rendered while a category tab on /rewards/analytics is
 * loading. Sized to the deep-stats panel shape (KPI strip + chart +
 * two side-by-side tables) so the layout doesn't shift when the
 * real content lands.
 *
 * Used inside `<Suspense fallback={...} key={category}>` on the
 * tabbed page so swapping tabs shows a skeleton instead of stale
 * numbers from the previous tab.
 */
export function RewardsAnalyticsTabSkeleton() {
  return (
    <div className="space-y-3">
      <SectionHeadingSkeleton titleWidth={180} />
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

/**
 * Fallback rendered while the cohort + distribution + top-cap section
 * of the Deposit Bonus tab streams in. The headline KPI strip + chart
 * + top-N tables paint first under the panel; this lazier section
 * sits below the fold and gets its own (cheaper-looking) skeleton.
 *
 * Sized to the actual section shape: 2 cohort tiles, one cohort-
 * compare card, one distribution chart, one top-cap-deposits table.
 */
export function DepositBonusCohortSkeleton() {
  return (
    <div className="space-y-6">
      <KpiStripSkeleton count={2} />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={180} />
        <Skeleton className="h-32 rounded-2xl" />
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={220} />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={240} />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    </div>
  );
}

/**
 * Bigger fallback for the Overview tab, which has more sections than
 * a per-category deep-stats tab. Matches the full shape: KPI strip,
 * chart, breakdown + summary side-by-side, platform leaderboards,
 * and the top-recipients table.
 */
export function OverviewTabSkeleton() {
  return (
    <div className="space-y-6">
      <KpiStripSkeleton count={6} />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={220} />
        <ChartSkeleton height={340} title={false} />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="space-y-3">
          <SectionHeadingSkeleton titleWidth={180} />
          <Skeleton className="h-72 rounded-2xl" />
        </div>
        <div className="space-y-3">
          <SectionHeadingSkeleton titleWidth={160} />
          <StatPanelSkeleton rows={6} />
        </div>
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={180} />
        <TableSkeleton rows={8} columns={4} />
      </div>
    </div>
  );
}
