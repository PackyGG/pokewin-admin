import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /gift-cards: hero with Create button, 4 KPI tiles (Total /
 * Available / Redeemed / Page Value), "All Gift Cards" section heading,
 * search toolbar with single Status filter, and the gift cards table.
 */
export default function GiftCardsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <KpiStripSkeleton count={4} />
      <div className="space-y-4">
        <ToolbarSkeleton filters={1} />
        <TableSkeleton rows={12} columns={7} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
