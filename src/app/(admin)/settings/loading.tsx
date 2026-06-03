import {
  PageHeroSkeleton,
  SectionHeadingSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Matches /settings: hero, then a Vault Lock Times section (heading +
 * small 3-col table inside a bordered card with an add-row below) and a
 * Country Restrictions section (heading + wide multi-column toggle
 * table). Structured to mirror the real SectionHeading + table layout so
 * the swap to real content doesn't jank.
 */
export default function SettingsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />

      {/* Vault Lock Times */}
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={150} />
        <div className="space-y-4 rounded-md border p-4">
          <TableSkeleton rows={3} columns={3} />
          <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-end sm:gap-4">
            <Skeleton className="h-9 w-full sm:w-24" />
            <Skeleton className="h-9 flex-1" />
            <Skeleton className="h-9 w-20 rounded-md" />
          </div>
        </div>
      </div>

      {/* Country Restrictions */}
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={180} />
        <TableSkeleton rows={6} columns={9} />
      </div>
    </div>
  );
}
