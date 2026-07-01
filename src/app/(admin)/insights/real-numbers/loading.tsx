import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for /insights/real-numbers — keeps the
 * shell (PageHero) + tab-nav painted immediately while the active tab's
 * Server Component resolves. The DEFAULT landing tab is now Analytics
 * (deposit-cadence figures), a light read, so this mirrors the Analytics
 * tab's chrome (hero → tab-nav → section heading → 3-tile KPI strip) rather
 * than the heavy Real-Numbers silhouette, so nothing jumps on cold nav.
 */
export default function RealNumbersLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />

      {/* Tab-nav pill row */}
      <Skeleton className="h-10 w-full max-w-md rounded-lg" />

      {/* Analytics landing — deposit-cadence section + 3-tile KPI strip */}
      <div className="space-y-5">
        <SectionHeadingSkeleton titleWidth={180} />
        <KpiStripSkeleton count={3} />
      </div>
    </div>
  );
}
