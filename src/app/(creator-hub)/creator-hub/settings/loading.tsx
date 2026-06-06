import { PageHeroSkeleton } from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for Creator Hub → Settings. Mirrors the hero
 * and integration-keys form shell.
 */
export default function CreatorHubSettingsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />

      <div className="space-y-4">
        <Skeleton className="h-[72px] rounded-xl" />
        <div className="space-y-3 rounded-xl border bg-card p-4 sm:p-5">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="space-y-2 border-b pb-4 last:border-0 last:pb-0">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-9 w-full rounded-md" />
              <Skeleton className="h-3 w-48" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
