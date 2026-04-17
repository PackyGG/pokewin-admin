import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHeroSkeleton,
  TabBarSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /settings: hero, settings tabs (General / Rewards / Restrictions /
 * Maintenance), active tab panel with form rows.
 */
export default function SettingsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="space-y-4">
        <TabBarSkeleton count={4} />
        <Skeleton className="h-[480px] rounded-2xl" />
      </div>
    </div>
  );
}
