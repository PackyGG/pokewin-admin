import {
  PageHeroSkeleton,
  TabBarSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /challenges: hero with Create button, status tabs (All / Active /
 * Inactive / Archived — filtering is via tabs, no toolbar), and a 7-column
 * challenges table (Name / Kind / Prize / Claims / Status / Created / Actions).
 */
export default function ChallengesLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <div className="space-y-4">
        <TabBarSkeleton count={4} />
        <TableSkeleton rows={10} columns={7} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
