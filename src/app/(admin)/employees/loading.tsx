import { PageHeroSkeleton } from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Matches /employees: hero, a create-workspace bar, then a horizontal
 * row of column skeletons (Unassigned + workspaces).
 */
export default function EmployeesLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="flex items-center gap-2">
        <Skeleton className="h-8 w-full max-w-xs rounded-lg" />
        <Skeleton className="h-8 w-32 rounded-lg" />
      </div>
      <div className="flex gap-4 overflow-hidden">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-72 w-[280px] shrink-0 rounded-2xl" />
        ))}
      </div>
    </div>
  );
}
