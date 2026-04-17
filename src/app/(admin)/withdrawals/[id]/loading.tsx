import { Skeleton } from "@/components/ui/skeleton";
import {
  DetailHeroSkeleton,
  SectionHeadingSkeleton,
  KpiStripSkeleton,
} from "@/components/loading-skeletons";

/** Matches /withdrawals/[id]: detail hero, KPI strip, timeline, detail panels. */
export default function WithdrawalDetailLoading() {
  return (
    <div className="space-y-6">
      <DetailHeroSkeleton action />
      <KpiStripSkeleton count={4} />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={120} />
        <Skeleton className="h-24 rounded-2xl" />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-64 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    </div>
  );
}
