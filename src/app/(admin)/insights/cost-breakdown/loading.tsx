import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton — keeps the shell visible while the
 * Server Component resolves the cost-breakdown aggregation (which fans
 * out to the Money Flow decomposition + the contributor sweep). On the
 * lifetime window these are the heaviest queries, so a skeleton beats a
 * blank screen.
 */
export default function Loading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-24 rounded-2xl" />
      <Skeleton className="h-20 rounded-2xl" />
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <Skeleton className="h-24 rounded-2xl" />
        <Skeleton className="h-24 rounded-2xl" />
        <Skeleton className="h-24 rounded-2xl" />
        <Skeleton className="h-24 rounded-2xl" />
      </div>
      <Skeleton className="h-96 rounded-2xl" />
      <Skeleton className="h-72 rounded-2xl" />
    </div>
  );
}
