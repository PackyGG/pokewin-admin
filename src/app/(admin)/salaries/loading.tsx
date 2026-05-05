import {
  PageHeroSkeleton,
  KpiStripSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Matches /salaries: hero, 4 KPI tiles (Active Employees, Monthly
 * Budget, Paid This Month, Paid YTD), then a stacked Employees card
 * and Payment Log card. Auto-payment wallet was removed when the
 * page pivoted to manual register + QR codes, so no 400px sidebar
 * panel anymore.
 */
export default function SalariesLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <KpiStripSkeleton count={4} />
      <div className="space-y-4">
        <Skeleton className="h-72 rounded-xl" />
        <Skeleton className="h-80 rounded-xl" />
      </div>
    </div>
  );
}
