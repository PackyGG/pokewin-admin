import {
  KpiStripSkeleton,
  PageHeroSkeleton,
  SectionHeadingSkeleton,
  TabBarSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Matches the reworked /system/geo-blocking (2026-07-12): hero, the "Geo
 * Blocking" section heading, the 3-tile KPI strip (Countries / Restricted /
 * Unrestricted), the search input, the Restricted/All countries tab bar,
 * and the collapsed 3-column restrictions table (Country / Blocked /
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
        <KpiStripSkeleton count={3} />
        <Skeleton className="h-9 w-full sm:max-w-sm" />
        <TabBarSkeleton count={2} />
        <TableSkeleton rows={10} columns={3} />
      </div>
    </div>
  );
}
