import {
  DetailHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  ChartRowSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

/** Matches hub ad detail: hero, KPI strip, wager source, chart, tables. */
export default function HubAdCodeDetailLoading() {
  return (
    <div className="space-y-6">
      <DetailHeroSkeleton action />
      <KpiStripSkeleton count={6} />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={160} />
        <TableSkeleton rows={8} columns={8} />
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={120} />
        <ChartRowSkeleton count={1} height={260} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-3">
          <SectionHeadingSkeleton titleWidth={100} />
          <TableSkeleton rows={6} columns={3} />
        </div>
        <div className="space-y-3">
          <SectionHeadingSkeleton titleWidth={140} />
          <TableSkeleton rows={6} columns={5} />
        </div>
      </div>
    </div>
  );
}
