import {
  PageTitleSkeleton,
  StatCardRowSkeleton,
  ChartRowSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

export default function CreatorAnalyticsLoading() {
  return (
    <div className="space-y-6">
      <PageTitleSkeleton width={180} />
      <StatCardRowSkeleton count={4} />
      <ChartRowSkeleton count={2} height={300} />
      <TableSkeleton rows={10} />
    </div>
  );
}
