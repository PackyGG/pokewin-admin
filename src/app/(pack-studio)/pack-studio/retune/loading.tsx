import {
  PageHeroSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for the Bulk Re-tune Review. Mirrors the page
 * shell — hero + a "Review queue" section heading — and a large card-stack
 * placeholder (rail + the BEFORE→AFTER review card) so the first paint matches
 * the eventual layout while the server resolves access + the dry-run proposals.
 */
export default function PackRetuneReviewLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={110} />
        <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
          <Skeleton className="hidden h-[28rem] rounded-xl lg:block" />
          <Skeleton className="h-[28rem] rounded-xl" />
        </div>
      </div>
    </div>
  );
}
