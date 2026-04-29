import {
  PageHeroSkeleton,
  TabBarSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /rain: hero, top-level Instances/Config tabs (default Instances),
 * search toolbar with Status filter + range filters, and a 9-column rain
 * instances table (ID / Status / Base / Tips / Total Pool / Participants
 * / Winner / Starts / Ends).
 */
export default function RainLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="space-y-4">
        <TabBarSkeleton count={2} />
        <ToolbarSkeleton filters={2} />
        <TableSkeleton rows={10} columns={9} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
