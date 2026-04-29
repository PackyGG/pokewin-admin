import { Skeleton } from "@/components/ui/skeleton";
import {
  DetailHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  GridSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /withdrawals/[id]: detail hero with status badges + action
 * buttons, status timeline (rendered inside hero in real life — doesn't
 * need a dedicated placeholder), 4-tile KPI strip, full-width 2-col
 * Details panel, and an items grid for the cards being shipped.
 */
export default function WithdrawalDetailLoading() {
  return (
    <div className="space-y-6">
      <DetailHeroSkeleton action />
      <KpiStripSkeleton count={4} />
      <Skeleton className="h-72 rounded-2xl" />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={100} />
        <GridSkeleton count={6} cols={6} aspect="card" />
      </div>
    </div>
  );
}
