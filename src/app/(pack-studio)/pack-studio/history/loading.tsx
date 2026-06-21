import {
  PageHeroSkeleton,
  SectionHeadingSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

/**
 * Route-level loading skeleton for Pack Change History. Mirrors the page shell —
 * hero, a "Captured snapshots" section heading, and the timeline — so the first
 * paint matches the eventual layout while the server component resolves the
 * owner gate + the ADMIN/MAIN reads.
 */
export default function PackHistoryLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={150} />
        <TableSkeleton rows={8} columns={5} />
      </div>
    </div>
  );
}
