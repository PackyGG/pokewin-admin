import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shared tab loading skeleton. Each Suspense'd tab segment uses this
 * fallback so navigation between tabs stays responsive even while the
 * heavy aggregate query is in flight.
 */
export function TabSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
      <Skeleton className="h-[420px]" />
    </div>
  );
}
