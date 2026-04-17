import {
  PageHeroSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/** Matches /rewards/level-up: hero (create button), rewards table. */
export default function LevelUpLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <div className="space-y-4">
        <TableSkeleton rows={12} columns={5} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
