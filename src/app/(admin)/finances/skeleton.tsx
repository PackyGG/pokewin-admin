import { Skeleton } from "@/components/ui/skeleton";

export function FinancesOverviewSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {Array.from({ length: 4 }).map((_, card) => (
        <div
          key={card}
          className="min-h-[310px] rounded-2xl bg-card py-4 ring-1 ring-foreground/10"
        >
          <div className="flex items-start justify-between gap-4 border-b px-4 pb-4">
            <div className="space-y-2">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-4 w-40" />
            </div>
            {card === 1 && <Skeleton className="h-9 w-52 rounded-lg" />}
          </div>
          <div className="space-y-6 px-4 pt-4">
            <div className="space-y-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-12 w-48" />
            </div>
            <div className="grid grid-cols-3 gap-2">
              {Array.from({ length: 3 }).map((_, index) => (
                <Skeleton key={index} className="h-16 rounded-lg" />
              ))}
            </div>
            <Skeleton className="h-4 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}
