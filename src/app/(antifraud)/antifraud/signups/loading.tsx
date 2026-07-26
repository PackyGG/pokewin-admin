import { Skeleton } from "@/components/ui/skeleton";

export default function AntifraudSignupsLoading() {
  return (
    <div className="w-full space-y-5">
      <div className="flex items-start gap-3 border-b border-border/60 pb-4">
        <Skeleton className="size-9 rounded-lg" />
        <div className="space-y-2">
          <Skeleton className="h-6 w-28" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
      </div>
      <Skeleton className="h-[67px] w-full rounded-lg" />
      <div className="overflow-hidden rounded-lg border border-border/70">
        {Array.from({ length: 6 }).map((_, index) => (
          <div
            key={index}
            className="flex items-center gap-3 border-b border-border/60 p-4 last:border-b-0"
          >
            <Skeleton className="size-10 shrink-0 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-44" />
              <Skeleton className="h-3 w-72 max-w-full" />
            </div>
            <Skeleton className="h-6 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}
