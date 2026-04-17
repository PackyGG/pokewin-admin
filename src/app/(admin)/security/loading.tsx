import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHeroSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";

/** Matches /security: hero, country restrictions panel, lockdown controls. */
export default function SecurityLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={180} />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={160} />
        <Skeleton className="h-48 rounded-2xl" />
      </div>
    </div>
  );
}
