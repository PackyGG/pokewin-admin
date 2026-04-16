import {
  DetailHeaderSkeleton,
  StatCardRowSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

export default function RaffleDetailLoading() {
  return (
    <div className="space-y-6">
      <DetailHeaderSkeleton />
      <StatCardRowSkeleton count={4} height={100} />
      <TableSkeleton rows={10} />
    </div>
  );
}
