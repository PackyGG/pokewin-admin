import {
  DetailHeaderSkeleton,
  StatCardRowSkeleton,
  ChartRowSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

export default function CreatorCodeDetailLoading() {
  return (
    <div className="space-y-6">
      <DetailHeaderSkeleton />
      <StatCardRowSkeleton count={4} />
      <ChartRowSkeleton count={2} height={260} />
      <TableSkeleton rows={10} />
    </div>
  );
}
