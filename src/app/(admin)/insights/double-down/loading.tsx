import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for /insights/double-down. Mirrors the page
 * chrome 1:1 so a cold navigation never jumps: the hero (with the period
 * chips), the 6-tile KPI strip, the "Audit log" heading + search box, then
 * the log table skeleton.
 */
export default function DoubleDownLoading() {
  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <PageHeroSkeleton />
        <Skeleton className="h-8 w-72 rounded-lg" />
      </div>

      <KpiStripSkeleton count={6} />

      <section className="space-y-3">
        <SectionHeadingSkeleton titleWidth={80} />
        <div className="w-full sm:max-w-md">
          <Skeleton className="h-9 w-full rounded-md" />
        </div>
        <TableSkeleton rows={8} />
      </section>
    </div>
  );
}
