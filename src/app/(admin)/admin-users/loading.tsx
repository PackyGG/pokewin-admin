import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /admin-users (Admins & Access) on its default Admins tab: hero
 * with Create + Balance Limits actions, 4–5 KPI tiles (the 5th "With
 * Balance Limits" tile renders only for real admins — we render 5 to match
 * the most common admin view), and an 8-column admins table. The tab strip
 * sits between the hero and the KPI strip; the skeleton omits it (it paints
 * instantly from the client nav).
 */
export default function AdminUsersLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <KpiStripSkeleton count={5} />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={100} />
        <TableSkeleton rows={10} columns={8} />
      </div>
    </div>
  );
}
