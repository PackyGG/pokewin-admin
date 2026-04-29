import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHeroSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /settings: hero, then a Vault Lock Times card and a Country
 * Restrictions card (with a wide multi-column toggle table). No tab nav
 * — the page just renders these sections sequentially.
 */
export default function SettingsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <Skeleton className="h-48 rounded-2xl" />
      <Skeleton className="h-[480px] rounded-2xl" />
    </div>
  );
}
