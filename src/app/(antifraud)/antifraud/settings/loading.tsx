import { PageHeroSkeleton } from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Matches /antifraud/settings: hero, tab nav, then the active tab's section
 * (integration status list on General, Discord config on Discord).
 */
export default function SettingsLoading() {
  return (
    <div className="space-y-4">
      <PageHeroSkeleton />
      <Skeleton className="h-10 w-52 rounded-lg" />
      <div className="space-y-4">
        <div className="flex items-center gap-2.5">
          <Skeleton className="size-7 rounded-lg" />
          <Skeleton className="h-4 w-40" />
        </div>
        <Skeleton className="h-56 w-full rounded-xl" />
      </div>
    </div>
  );
}
