import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  ChartRowSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /analytics: hero (with period filter), 6 stat cards, battle/pack
 * breakdown cards, acquisition + gameplay chart rows.
 */
export default function AnalyticsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <KpiStripSkeleton count={6} />
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-64 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={140} />
        <ChartRowSkeleton count={3} height={300} />
      </div>
    </div>
  );
}
