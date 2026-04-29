import {
  PageHeroSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /rewards/level-up: hero with Create button, 7-column rewards
 * table (Level / Name / Type / Cash / Packs / Created / Actions).
 */
export default function LevelUpLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <div className="space-y-4">
        <TableSkeleton rows={12} columns={7} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
