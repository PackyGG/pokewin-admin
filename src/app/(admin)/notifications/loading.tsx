import { PageHeroSkeleton, TableSkeleton } from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shell-first loading state — hero + tab strip paint immediately while the
 * GET /admin/announcements backend call resolves.
 */
export default function NotificationsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <Skeleton className="h-10 w-full max-w-xs rounded-lg" />
      <div className="space-y-4">
        <TableSkeleton rows={8} columns={5} />
      </div>
    </div>
  );
}
