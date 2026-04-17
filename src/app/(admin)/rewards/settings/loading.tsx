import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHeroSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";

/** Matches /rewards/settings: hero, rakeback config panel, global switches panel. */
export default function RewardsSettingsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={180} action />
        <Skeleton className="h-48 rounded-2xl" />
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={120} />
        <Skeleton className="h-40 rounded-2xl" />
      </div>
    </div>
  );
}
