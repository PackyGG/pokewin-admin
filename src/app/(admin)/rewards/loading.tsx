import {
  PageHeroSkeleton,
  TabBarSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches the merged /rewards page: hero, the top-level tab switch (ten tabs —
 * Rain … Settings; the count must track `TABS` in page.tsx or the bar visibly
 * resizes when the real page swaps in), and — for the default Rain / Instances
 * view — a 9-column rain instances table (ID / Status / Base / Tips / Total
 * Pool / Participants / Winner / Starts / Ends). The inner Rain sub-tabs and
 * the search toolbar stream in behind their own boundaries.
 */
export default function RewardsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="space-y-4">
        <TabBarSkeleton count={10} />
        <TableSkeleton rows={10} columns={9} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
