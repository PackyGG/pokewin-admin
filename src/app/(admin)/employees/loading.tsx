import { PageHeroSkeleton } from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Matches /employees: hero, the toolbar (create-workspace +
 * create-discord-server), a horizontal row of workspace column
 * skeletons (Unassigned + workspaces), then a second horizontal row
 * for the discord servers section.
 */
export default function EmployeesLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-8 w-full max-w-xs rounded-lg" />
        <Skeleton className="h-8 w-32 rounded-lg" />
        <Skeleton className="h-8 w-full max-w-xs rounded-lg" />
        <Skeleton className="h-8 w-40 rounded-lg" />
      </div>
      <div className="flex gap-4 overflow-hidden">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-72 w-[280px] shrink-0 rounded-2xl" />
        ))}
      </div>
      <div className="space-y-2">
        <Skeleton className="h-6 w-48 rounded-lg" />
        <div className="flex gap-4 overflow-hidden">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-72 w-[280px] shrink-0 rounded-2xl" />
          ))}
        </div>
      </div>
    </div>
  );
}
