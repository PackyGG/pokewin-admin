import { Skeleton } from "@/components/ui/skeleton";

/**
 * Matches /antifraud: six aligned KPI cards, action feed and the two 30-day
 * charts.
 */
export default function AntifraudOverviewLoading() {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full rounded-xl" />
        ))}
      </div>
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(300px,0.8fr)_minmax(0,2.2fr)]">
        <Skeleton className="h-[336px] w-full rounded-xl" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-[336px] w-full rounded-xl" />
          <Skeleton className="h-[336px] w-full rounded-xl" />
        </div>
      </div>
    </div>
  );
}
