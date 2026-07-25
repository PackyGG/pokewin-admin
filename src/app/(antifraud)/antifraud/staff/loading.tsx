import { PageHeroSkeleton } from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/** Matches /antifraud/staff: hero, four KPI tiles, the ranked team board. */
export default function StaffMembersLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full rounded-2xl" />
        ))}
      </div>
      <div className="space-y-4">
        <div className="flex items-center gap-2.5">
          <Skeleton className="size-7 rounded-lg" />
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="overflow-hidden rounded-xl border border-border/60">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full rounded-none" />
          ))}
        </div>
      </div>
    </div>
  );
}
