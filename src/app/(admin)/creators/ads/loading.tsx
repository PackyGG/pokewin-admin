import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

/** Matches /creators/ads: hero (badge + create), KPI strip, summary card, ad codes table. */
export default function AdsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <KpiStripSkeleton count={6} />
      <Skeleton className="h-20 rounded-2xl" />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={140} />
        <TableSkeleton rows={8} columns={7} />
      </div>
    </div>
  );
}
