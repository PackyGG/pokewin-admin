import {
  PageHeroSkeleton,
  SectionHeadingSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for /insights/affiliate-codes. Mirrors the
 * page chrome 1:1 so a cold navigation never jumps: the hero (with the
 * search box), the "Results" section heading, then the results table
 * skeleton.
 */
export default function AffiliateCodesLoading() {
  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <PageHeroSkeleton />
        <div className="w-full sm:max-w-md">
          <Skeleton className="h-9 w-full rounded-md" />
        </div>
      </div>

      <section className="space-y-3">
        <SectionHeadingSkeleton titleWidth={80} />
        <TableSkeleton rows={4} />
      </section>
    </div>
  );
}
