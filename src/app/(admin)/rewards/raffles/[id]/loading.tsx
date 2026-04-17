import {
  DetailHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/** Matches /rewards/raffles/[id]: detail hero, stat tiles, entries table. */
export default function RaffleDetailLoading() {
  return (
    <div className="space-y-6">
      <DetailHeroSkeleton action />
      <KpiStripSkeleton count={4} />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={80} />
        <TableSkeleton rows={10} columns={5} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
