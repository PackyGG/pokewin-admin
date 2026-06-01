import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton — fires while the Server Component
 * resolves on initial navigation. Matches the page chrome (hero + tab
 * row + tab body) so the layout doesn't jump when the data lands.
 */
export default function Loading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-28 rounded-2xl" />
      <Skeleton className="h-11" />
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
