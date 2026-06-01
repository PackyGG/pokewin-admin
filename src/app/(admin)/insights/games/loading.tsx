import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton — keeps the shell visible while the
 * Server Component resolves. The per-tab Suspense in page.tsx
 * handles the post-mount tab swaps.
 */
export default function Loading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-24 rounded-2xl" />
      <Skeleton className="h-10 rounded-lg" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Skeleton className="h-24 rounded-2xl" />
        <Skeleton className="h-24 rounded-2xl" />
        <Skeleton className="h-24 rounded-2xl" />
        <Skeleton className="h-24 rounded-2xl" />
        <Skeleton className="h-24 rounded-2xl" />
        <Skeleton className="h-24 rounded-2xl" />
      </div>
      <Skeleton className="h-72 rounded-2xl" />
    </div>
  );
}
