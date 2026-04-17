import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHeroSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /settings/roles: hero, role tabs, grouped permission panels
 * (pages × capabilities).
 */
export default function RolePermissionsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <Skeleton className="h-10 w-full max-w-md" />
      <div className="space-y-6">
        {Array.from({ length: 3 }).map((_, g) => (
          <div key={g} className="space-y-3">
            <SectionHeadingSkeleton titleWidth={120} />
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-48 rounded-xl" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
