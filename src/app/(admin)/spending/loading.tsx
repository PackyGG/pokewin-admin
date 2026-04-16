import {
  PageTitleSkeleton,
  StatCardRowSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

export default function SpendingLoading() {
  return (
    <div className="space-y-6">
      <PageTitleSkeleton width={120} />
      <StatCardRowSkeleton count={3} height={100} />
      <TableSkeleton rows={10} />
    </div>
  );
}
