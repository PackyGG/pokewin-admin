import {
  PageHeroSkeleton,
  TabBarSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /rewards/raffles: hero with Create button, status tabs (All /
 * Active / Completed / Cancelled — no toolbar, filtering is via tabs),
 * and an 8-column raffles table (Name / Status / Entries / Participants
 * / Winner / Starts / Ends / Actions).
 */
export default function RafflesLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <div className="space-y-4">
        <TabBarSkeleton count={4} />
        <TableSkeleton rows={10} columns={8} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
