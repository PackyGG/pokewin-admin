import { Skeleton } from "@/components/ui/skeleton";
import {
  DetailHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /rewards/raffles/[id]: detail hero with status badge + edit/
 * cancel actions (only on active raffles), 3 KPI tiles (Total Entries /
 * Participants / Prizes), Details panel, optional Prizes section, and
 * a 3-column entries table (User / Points Spent / Date).
 */
export default function RaffleDetailLoading() {
  return (
    <div className="space-y-6">
      <DetailHeroSkeleton action />
      <KpiStripSkeleton count={3} />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={80} />
        <Skeleton className="h-48 rounded-2xl" />
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={120} />
        <TableSkeleton rows={10} columns={3} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
