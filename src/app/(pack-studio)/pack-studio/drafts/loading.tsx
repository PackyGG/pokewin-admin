import {
  PageHeroSkeleton,
  SectionHeadingSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

/**
 * Route-level loading skeleton for the Pack Drafts list — mirrors the page
 * shell (hero + "Pending drafts" section heading + table) so first paint
 * matches the eventual layout while the server resolves access + pending
 * draft rows.
 */
export default function PackDraftsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={140} />
        <TableSkeleton rows={6} columns={6} />
      </div>
    </div>
  );
}
