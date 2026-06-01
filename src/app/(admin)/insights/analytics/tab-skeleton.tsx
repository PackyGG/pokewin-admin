import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shared Suspense fallback for /insights/analytics tabs. Mirrors the
 * /analytics tab skeleton — same vertical rhythm so the switch feels
 * instant even when the underlying query is heavy.
 */
export function InsightsTabSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 grid-cols-2 sm:gap-4 md:grid-cols-3 lg:grid-cols-6">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
      </div>
      <Skeleton className="h-80 rounded-2xl" />
      <Skeleton className="h-80 rounded-2xl" />
    </div>
  );
}
