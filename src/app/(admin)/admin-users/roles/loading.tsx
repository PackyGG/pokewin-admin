import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHeroSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

/**
 * The /admin-users/roles page doesn't use the modern PageHero yet — it
 * still renders a classic title + subtitle + create button. Skeleton
 * keeps that shape.
 */
export default function AdminRolesLoading() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-36" />
          <Skeleton className="h-4 w-80" />
        </div>
        <Skeleton className="h-9 w-28 rounded-md" />
      </div>
      <TableSkeleton rows={6} columns={5} />
    </div>
  );
}
