import { Skeleton } from "@/components/ui/skeleton";
import { PageHeroSkeleton } from "@/components/loading-skeletons";

/** Matches /creators/settings: hero, affiliate expiration card, level configs. */
export default function CreatorSettingsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <Skeleton className="h-40 rounded-2xl" />
      <Skeleton className="h-96 rounded-2xl" />
    </div>
  );
}
