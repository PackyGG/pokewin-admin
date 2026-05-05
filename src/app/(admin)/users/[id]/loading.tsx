import { Skeleton } from "@/components/ui/skeleton";
import {
  KpiStripSkeleton,
  TabBarSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /users/[id]: simple back-link header (no full PageHero), large
 * hero KPI strip from UserViewModern, segmented tab bar, and tabbed
 * content (panels + tables). The hero KPIs are 7 wide on xl screens.
 */
export default function UserDetailLoading() {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Skeleton className="size-9 rounded-md" />
        <div className="space-y-1.5">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>

      {/* Modern user view: identity hero with avatar + status pills + KPIs. */}
      <Skeleton className="h-32 rounded-2xl" />

      <KpiStripSkeleton count={7} />

      <TabBarSkeleton count={7} />

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-48 rounded-2xl" />
        <Skeleton className="h-48 rounded-2xl" />
        <Skeleton className="h-48 rounded-2xl" />
      </div>
      <Skeleton className="h-64 rounded-2xl" />
    </div>
  );
}
