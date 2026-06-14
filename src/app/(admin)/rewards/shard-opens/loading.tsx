import {
  PageHeroSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /rewards/shard-opens: hero (with the period-filter action), a
 * 7-tile KPI strip (Opens / Unique openers / Shards wagered / Shards won /
 * Net house / Avg per open / House edge), a per-pack breakdown panel, and
 * the opens feed table (6-column row).
 */
export default function ShardOpensLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <div className="h-12 animate-pulse rounded-xl border bg-muted/20" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-7">
        {Array.from({ length: 7 }).map((_, i) => (
          <div
            key={i}
            className="h-[72px] animate-pulse rounded-xl border bg-muted/30"
          />
        ))}
      </div>
      <div className="h-48 animate-pulse rounded-2xl border bg-muted/30" />
      <TableSkeleton rows={8} columns={6} />
      <PaginationSkeleton />
    </div>
  );
}
