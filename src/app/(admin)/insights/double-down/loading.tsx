import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  TableSkeleton,
  ChartSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for /insights/double-down. Mirrors the page
 * chrome 1:1 so a cold navigation never jumps: the hero (with the period
 * chips), the 4-tile KPI strip, then a 2-col section — LEFT the "Audit log"
 * heading + search box + table skeleton, RIGHT the "Trends" heading + two
 * stacked chart skeletons.
 */
export default function DoubleDownLoading() {
  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <PageHeroSkeleton />
        <Skeleton className="h-8 w-72 rounded-lg" />
      </div>

      <KpiStripSkeleton count={4} />

      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        <section className="space-y-3">
          <SectionHeadingSkeleton titleWidth={80} />
          <div className="w-full sm:max-w-md">
            <Skeleton className="h-9 w-full rounded-md" />
          </div>
          <TableSkeleton rows={8} />
        </section>

        <section className="space-y-3">
          <SectionHeadingSkeleton titleWidth={60} />
          <div className="flex flex-col gap-4">
            <ChartSkeleton height={200} />
            <ChartSkeleton height={200} />
          </div>
        </section>
      </div>
    </div>
  );
}
