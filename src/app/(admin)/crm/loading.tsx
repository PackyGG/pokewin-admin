import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  ChartRowSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /crm: hero, a 6-tile KPI strip, then two 2-column rows
 * (lifecycle + VIP tiers, dormant whales + top value).
 */
export default function CrmLoading() {
  return (
    <div className="space-y-5">
      <PageHeroSkeleton />
      <KpiStripSkeleton count={6} />
      <ChartRowSkeleton count={2} height={260} />
      <ChartRowSkeleton count={2} height={260} />
    </div>
  );
}
