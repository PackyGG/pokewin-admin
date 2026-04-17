import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shared Suspense fallback for a tab panel. Every tab uses the same footprint
 * so switching feels instant while the new segment loads.
 */
export function TabSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-28 rounded-2xl" />
        <Skeleton className="h-28 rounded-2xl" />
        <Skeleton className="h-28 rounded-2xl" />
      </div>
      <Skeleton className="h-96 rounded-2xl" />
    </div>
  );
}
