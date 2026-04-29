import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHeroSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /profile (admin self-edit form): narrow max-width 2xl wrapper,
 * hero with role badge, and two sections — Profile and Preferences,
 * each rendered as a card.
 */
export default function ProfileLoading() {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <PageHeroSkeleton />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={80} />
        <Skeleton className="h-72 rounded-xl" />
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={120} />
        <Skeleton className="h-56 rounded-xl" />
      </div>
    </div>
  );
}
