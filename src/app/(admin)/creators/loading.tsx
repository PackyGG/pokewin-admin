import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

/** Matches /creators: hero, KPI strip, toolbar, creators table. */
export default function CreatorsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <KpiStripSkeleton count={4} />
      <div className="space-y-4">
        <ToolbarSkeleton filters={0} />
        <TableSkeleton rows={10} columns={7} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
