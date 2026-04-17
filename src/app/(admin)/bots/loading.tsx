import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/** Matches /bots: hero, KPI strip, search toolbar, bots table. */
export default function BotsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <KpiStripSkeleton count={4} />
      <div className="space-y-4">
        <ToolbarSkeleton filters={0} />
        <TableSkeleton rows={8} columns={6} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
