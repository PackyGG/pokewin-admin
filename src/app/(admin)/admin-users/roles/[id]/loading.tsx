import { Skeleton } from "@/components/ui/skeleton";
import { DetailHeroSkeleton } from "@/components/loading-skeletons";

/**
 * Matches /admin-users/roles/[id]: classic back-button + title header
 * (no PageHero yet on this route) + large role editor panel.
 */
export default function RoleDetailLoading() {
  return (
    <div className="space-y-4">
      <DetailHeroSkeleton />
      <Skeleton className="h-96 rounded-xl" />
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}
