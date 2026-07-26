import {
  KpiStripSkeleton,
  PageHeroSkeleton,
  SectionHeadingSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Matches the reworked /system/geo-blocking (2026-07-12): hero, the "Geo
 * Blocking" section heading, the 6-tile KPI strip, the global card-deposit
 * + fiat-policy panels, the search input and the scope/restriction filter
 * dropdowns (which replaced the tab bar 2026-07-27), and the collapsed
 * 3-column restrictions table (Country / Blocked /
 * Restrictions — down from the old 9-column layout). Keeps the shell
 * painted immediately while the server read resolves so navigation is
 * shift-free instead of blank.
 */
export default function GeoBlockingLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="space-y-4">
        <SectionHeadingSkeleton titleWidth={120} />
        <KpiStripSkeleton count={6} />
        <Skeleton className="h-14 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-9 w-full sm:max-w-xs" />
          <Skeleton className="h-9 w-[170px]" />
          <Skeleton className="h-9 w-[230px]" />
        </div>
        <TableSkeleton rows={10} columns={3} />
      </div>
    </div>
  );
}
