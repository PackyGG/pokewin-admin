import { PageHeroSkeleton } from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for Creator Hub → Profitable Algo calculator.
 * Mirrors the hero and calculator panel layout.
 */
export default function ProfitableAlgoLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />

      <div className="space-y-4 rounded-2xl border bg-card p-4 sm:p-6">
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-9 w-full rounded-md" />
            </div>
          ))}
        </div>
        <Skeleton className="h-10 w-full rounded-md sm:w-40" />
        <div className="grid gap-3 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[88px] rounded-xl" />
          ))}
        </div>
      </div>
    </div>
  );
}
