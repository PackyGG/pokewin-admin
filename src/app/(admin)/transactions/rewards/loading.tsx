import {
  PageTitleSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

export default function RewardTransactionsLoading() {
  return (
    <div className="space-y-4">
      <PageTitleSkeleton width={200} />
      <ToolbarSkeleton />
      <TableSkeleton rows={15} />
    </div>
  );
}
