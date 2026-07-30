import { Skeleton } from "@/components/ui/skeleton";

/**
 * Mirrors /antifraud/monitor exactly: the seven KPI tiles, the two live
 * panels (each behind its section heading) and the case list. Heights match
 * the console's empty state so nothing jumps when the real content resolves.
 */
export default function AntifraudMonitorLoading() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-7">
        {Array.from({ length: 7 }).map((_, index) => (
          <Skeleton key={index} className="h-24 rounded-2xl" />
        ))}
      </div>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(340px,0.75fr)]">
        <div className="space-y-3">
          <HeadingSkeleton />
          <Skeleton className="h-[320px] rounded-xl" />
        </div>
        <div className="space-y-3">
          <HeadingSkeleton />
          <Skeleton className="h-[320px] rounded-xl" />
        </div>
      </div>
      <div className="space-y-3">
        <HeadingSkeleton />
        <Skeleton className="h-[130px] rounded-xl" />
      </div>
    </div>
  );
}

function HeadingSkeleton() {
  return (
    <div className="flex items-center gap-2.5">
      <Skeleton className="size-7 rounded-lg" />
      <Skeleton className="h-4 w-44" />
    </div>
  );
}
