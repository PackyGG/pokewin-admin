import {
  PageHeroSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/** Matches /rewards/raffles: hero (create button), search + filters, raffles table. */
export default function RafflesLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <div className="space-y-4">
        <ToolbarSkeleton filters={1} />
        <TableSkeleton rows={10} columns={7} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
