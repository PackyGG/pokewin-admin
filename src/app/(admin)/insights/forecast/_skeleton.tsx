import {
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { SkeletonChart } from "@/components/ux";

/**
 * Skeleton shown while the selected reward's forecast streams in.
 *
 * Mirrors the shared simulator's shape: a 6-tile KPI strip, a left controls
 * rail + a right chart grid, then the wide comparison table — so the swap into
 * the real island stays dimension-stable.
 */
export function ForecastHubSkeleton() {
  return (
    <div className="space-y-6">
      <KpiStripSkeleton count={6} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,340px)_1fr]">
        <div className="h-[520px] rounded-2xl border bg-card/40" />
        <div className="space-y-6">
          <div className="space-y-3">
            <SectionHeadingSkeleton titleWidth={180} />
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="h-24 rounded-xl border bg-card/40" />
              <div className="h-24 rounded-xl border bg-card/40" />
              <div className="h-24 rounded-xl border bg-card/40" />
            </div>
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <SkeletonChart height={256} variant="area" title={false} />
            <SkeletonChart height={256} variant="area" title={false} />
          </div>
        </div>
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={200} />
        <TableSkeleton rows={8} columns={6} />
      </div>
    </div>
  );
}
