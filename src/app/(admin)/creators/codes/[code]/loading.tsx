import { Skeleton } from "@/components/ui/skeleton";
import {
  DetailHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  ChartSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /creators/codes/[code]: detail hero with active badge, 7-tile
 * KPI strip (Signups / Active / Deposits / Depositors / Wagers /
 * Commission / Clicks), acquisition chart + country breakdown row,
 * conditional financial daily chart, and a 7-column referrals table.
 */
export default function CreatorCodeDetailLoading() {
  return (
    <div className="space-y-6">
      <DetailHeroSkeleton />
      <KpiStripSkeleton count={7} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <ChartSkeleton height={300} />
        </div>
        <Skeleton className="h-72 rounded-2xl" />
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={100} />
        <TableSkeleton rows={10} columns={7} />
      </div>
    </div>
  );
}
