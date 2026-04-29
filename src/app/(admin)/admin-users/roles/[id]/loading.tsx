import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHeroSkeleton,
  KpiStripSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /admin-users/roles/[id]: hero with back arrow + role badges,
 * 3 KPI tiles (Type / Capabilities / Assigned Admins), and a large
 * RoleEditor panel underneath.
 */
export default function RoleDetailLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <KpiStripSkeleton count={3} />
      <Skeleton className="h-96 rounded-xl" />
    </div>
  );
}
