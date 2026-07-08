import {
  PageHeroSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { SkeletonTable } from "@/components/ux";

/**
 * Matches /vips: hero, single "Total VIPs" KPI tile (grid-cols-1 max-w-xs,
 * not the multi-tile KpiStripSkeleton — this page has exactly one tile),
 * "Flagged accounts" section heading, VIP-user table. Shape mirrors
 * page.tsx 1:1 so the real content swaps in without layout jump.
 */
export default function VipsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="grid grid-cols-1 gap-3 sm:max-w-xs">
        <div className="rounded-xl border bg-card px-4 py-3">
          <div className="flex items-center gap-2">
            <Skeleton className="size-4 rounded" />
            <Skeleton className="h-3 w-16" />
          </div>
          <Skeleton className="mt-2 h-6 w-20" />
        </div>
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={140} />
        <SkeletonTable rows={8} columns={4} rowHeight={44} />
      </div>
    </div>
  );
}
