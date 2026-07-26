import { PageHeroSkeleton } from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Mirrors /antifraud/monitor exactly: hero, section heading, the four KPI
 * tiles, the two live panels and the case list. Heights match the console's
 * empty state so nothing jumps when the real content resolves.
 */
export default function AntifraudMonitorLoading() {
  return (
    <div className="space-y-5">
      <PageHeroSkeleton />
      <div className="flex items-center gap-2.5">
        <Skeleton className="size-7 rounded-lg" />
        <Skeleton className="h-4 w-44" />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-[76px] rounded-lg" />
        ))}
      </div>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(340px,0.75fr)]">
        <Skeleton className="h-[350px] rounded-xl" />
        <Skeleton className="h-[350px] rounded-xl" />
      </div>
      <Skeleton className="h-[130px] rounded-xl" />
    </div>
  );
}
