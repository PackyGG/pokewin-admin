import { Skeleton } from "@/components/ui/skeleton";

/**
 * Placeholder for the Discord workspace (tab bar + the XP tab's stat strip,
 * charts and rank-role editor). Shared by this route's `loading.tsx` and the
 * page's <Suspense> fallback so the navigation skeleton and the streaming
 * skeleton are the same shape.
 */
export function DiscordWorkspaceSkeleton() {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-32 rounded-md" />
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>

      <Skeleton className="h-64 w-full rounded-xl" />
      <Skeleton className="h-80 w-full rounded-xl" />
    </div>
  );
}
