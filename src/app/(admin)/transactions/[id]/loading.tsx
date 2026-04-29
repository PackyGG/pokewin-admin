import { Skeleton } from "@/components/ui/skeleton";
import {
  DetailHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /transactions/[id]: detail hero with status + type badges, 3
 * KPI tiles (Amount / Balance Before / Balance After), and a 2-col
 * Details section. Game session and crypto cards render conditionally.
 */
export default function TransactionDetailLoading() {
  return (
    <div className="space-y-6">
      <DetailHeroSkeleton />
      <KpiStripSkeleton count={3} />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={80} />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-96 rounded-2xl" />
          <Skeleton className="h-96 rounded-2xl" />
        </div>
      </div>
    </div>
  );
}
