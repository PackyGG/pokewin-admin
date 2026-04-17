import {
  DetailHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/** Matches /rain/[id]: detail hero, stat tiles, entries table. */
export default function RainDetailLoading() {
  return (
    <div className="space-y-6">
      <DetailHeroSkeleton />
      <KpiStripSkeleton count={3} />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={100} />
        <TableSkeleton rows={10} columns={5} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
