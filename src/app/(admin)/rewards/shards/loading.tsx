import {
  PageHeroSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /rewards/shards: hero with a Create button, a 4-tile KPI strip
 * (Shard packs / Active / Cards in pools / Avg shard cost), and the shard
 * pack list (5-column row: Pack / Shard cost / Cards per open / Card pool /
 * Actions).
 */
export default function ShardPacksLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-[72px] animate-pulse rounded-xl border bg-muted/30"
            />
          ))}
        </div>
        <TableSkeleton rows={6} columns={5} />
      </div>
    </div>
  );
}
