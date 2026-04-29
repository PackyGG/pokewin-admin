import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /admin-users/roles: hero with Create button, 4 KPI tiles
 * (Total / System / Custom / Assigned), and a 5-column roles table
 * (Name / Type / Capabilities / Users / Updated).
 */
export default function AdminRolesLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <KpiStripSkeleton count={4} />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={100} />
        <TableSkeleton rows={6} columns={5} />
      </div>
    </div>
  );
}
