import { PageHeroSkeleton, TableSkeleton } from "@/components/loading-skeletons";

/**
 * Shell-first loading state — hero paints immediately while the
 * GET /admin/announcements backend call resolves.
 */
export default function NotificationsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="space-y-4">
        <TableSkeleton rows={8} columns={5} />
      </div>
    </div>
  );
}
