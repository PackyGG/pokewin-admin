import { Skeleton } from "@/components/ui/skeleton";

/** Matches /antifraud/audit: three KPI tiles, filter bar and the action feed. */
export default function AntifraudAuditLoading() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-4 w-2/3 max-w-3xl rounded" />
      <Skeleton className="h-16 w-full rounded-xl" />
      <div className="grid gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-24 w-full rounded-xl" />
        ))}
      </div>
      {Array.from({ length: 6 }).map((_, index) => (
        <Skeleton key={index} className="h-20 w-full rounded-xl" />
      ))}
    </div>
  );
}
