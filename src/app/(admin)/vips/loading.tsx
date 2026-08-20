import {
  KpiStripSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";
import { SkeletonTable } from "@/components/ux";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Matches /vips: KPI strip, VIP perk settings, the roster and bot activity.
 * Shape mirrors page.tsx so streamed content swaps in without layout jump.
 */
export default function VipsLoading() {
  return (
    <div className="space-y-6">
      <KpiStripSkeleton count={5} />
      <div className="rounded-2xl border bg-card p-5">
        <div className="flex items-center justify-between">
          <Skeleton className="h-5 w-40 rounded" />
          <Skeleton className="h-9 w-32 rounded-xl" />
        </div>
        <Skeleton className="mt-3 h-3 w-full max-w-xl rounded" />
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-44 rounded-xl" />
          <Skeleton className="h-44 rounded-xl" />
        </div>
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={140} />
        <SkeletonTable rows={8} columns={10} rowHeight={76} />
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={160} />
        <div className="rounded-2xl border bg-card p-4">
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full rounded" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
