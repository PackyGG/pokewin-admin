import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHeroSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /rewards/settings: hero and a single Rakeback Configuration
 * section with a "Manage" action button on the heading and a list of
 * config rows in a rounded card below.
 */
export default function RewardsSettingsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={180} action />
        <Skeleton className="h-48 rounded-2xl" />
      </div>
    </div>
  );
}
