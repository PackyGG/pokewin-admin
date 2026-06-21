import {
  PageHeroSkeleton,
  TableSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/** Matches /physical: hero, availability controls, KPI strip, queue table. */
export default function PhysicalLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={120} />
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-44 rounded-2xl" />
          <Skeleton className="h-44 rounded-2xl" />
        </div>
      </div>
      <div className="grid gap-2.5 sm:gap-4 grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-2xl" />
        ))}
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={150} />
        <TableSkeleton rows={6} columns={7} />
      </div>
    </div>
  );
}
