import { PageHeroSkeleton, SectionHeadingSkeleton } from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for Creator Hub → Alerts.
 * Mirrors the page chrome: hero, 3 KPI boxes, attention queue rows.
 */
export default function CreatorHubAlertsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-[104px] rounded-2xl" />
        ))}
      </div>

      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={160} />
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-[120px] rounded-2xl" />
          ))}
        </div>
      </div>
    </div>
  );
}
