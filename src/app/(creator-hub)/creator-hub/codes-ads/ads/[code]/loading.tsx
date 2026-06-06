import {
  DetailHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  ChartRowSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

/** Matches /creator-hub/codes-ads/ads/[code] detail layout. */
export default function CreatorHubAdCodeDetailLoading() {
  return (
    <div className="space-y-6">
      <DetailHeroSkeleton action />
      <KpiStripSkeleton count={6} />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={120} />
        <ChartRowSkeleton count={2} height={260} />
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={100} />
        <TableSkeleton rows={10} columns={6} />
      </div>
    </div>
  );
}
