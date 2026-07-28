import { Skeleton } from "@/components/ui/skeleton";

import {
  SocialsQueueBodySkeleton,
  SocialsQueueTabsSkeleton,
} from "./skeletons";

/**
 * Route-level loading skeleton for Creator Hub → Socials Review. Mirrors the
 * real page 1:1 via the SAME shared skeletons the in-page Suspense fallbacks
 * use: SectionHeading row (icon chip + title + tab chips), then the queue
 * card with rows + pager.
 */
export default function SocialsReviewLoading() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="flex items-center gap-2.5">
          <Skeleton className="size-7 rounded-lg" />
          <Skeleton className="h-5 w-32 rounded" />
        </div>
        <SocialsQueueTabsSkeleton />
      </div>

      <div className="rounded-2xl border bg-card p-4">
        <SocialsQueueBodySkeleton />
      </div>
    </div>
  );
}
