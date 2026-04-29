import { Skeleton } from "@/components/ui/skeleton";
import {
  DetailHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /promo-codes/[id]: detail hero with delete action, 4 KPI tiles
 * (Value / Redemptions / Remaining / Expires), Details + Requirements
 * StatPanels in a 2-col grid, and a 3-column redemptions table.
 */
export default function PromoCodeDetailLoading() {
  return (
    <div className="space-y-6">
      <DetailHeroSkeleton action />
      <KpiStripSkeleton count={4} />
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-72 rounded-2xl" />
        <Skeleton className="h-72 rounded-2xl" />
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={140} />
        <TableSkeleton rows={8} columns={3} />
      </div>
    </div>
  );
}
