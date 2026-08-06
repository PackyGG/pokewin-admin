import { Skeleton } from "@/components/ui/skeleton";

/**
 * Mirrors /antifraud/monitor exactly: the header row, the seven KPI tiles
 * (2 / 3 / 4-column grid), the two fixed-height live panels and the bottom
 * two-column case/session lists. Heights match the console's fixed panel
 * heights so nothing jumps when the real content resolves.
 *
 * Lives in its own module because two places render it — `loading.tsx` (the
 * route-level fallback) and the page's `<Suspense>` boundary around the server
 * snapshot read. One definition, so the two can never drift apart.
 */
export function MonitorConsoleSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-1.5">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-3.5 w-64" />
        </div>
        <Skeleton className="h-8 w-24 rounded-md" />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 7 }).map((_, index) => (
          <Skeleton key={index} className="h-24 rounded-lg" />
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(340px,0.75fr)]">
        <div className="space-y-3">
          <HeadingSkeleton />
          <Skeleton className="h-[480px] rounded-xl" />
        </div>
        <div className="space-y-3">
          <HeadingSkeleton />
          <Skeleton className="h-[480px] rounded-xl" />
        </div>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="space-y-3">
          <HeadingSkeleton />
          <Skeleton className="h-[220px] rounded-xl" />
        </div>
        <div className="space-y-3">
          <HeadingSkeleton />
          <Skeleton className="h-[220px] rounded-xl" />
        </div>
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
