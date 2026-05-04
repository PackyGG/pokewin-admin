import {
  PageHeroSkeleton,
  KpiStripSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Matches /spending/salaries: hero with back arrow, 4 KPI tiles,
 * 400px wallet panel + employees table + recent payouts table.
 */
export default function SalariesLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <KpiStripSkeleton count={4} />
      <div className="grid gap-4 lg:grid-cols-[400px_1fr]">
        <Skeleton className="h-[420px] rounded-xl" />
        <div className="space-y-4">
          <Skeleton className="h-64 rounded-xl" />
          <Skeleton className="h-72 rounded-xl" />
        </div>
      </div>
    </div>
  );
}
