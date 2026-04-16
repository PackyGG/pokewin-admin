import {
  PageTitleSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

export default function WithdrawalsLoading() {
  return (
    <div className="space-y-4">
      <PageTitleSkeleton width={150} />
      <ToolbarSkeleton />
      <TableSkeleton rows={12} />
    </div>
  );
}
