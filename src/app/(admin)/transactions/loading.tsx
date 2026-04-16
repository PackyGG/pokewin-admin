import {
  PageTitleSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

export default function TransactionsLoading() {
  return (
    <div className="space-y-4">
      <PageTitleSkeleton width={160} />
      <ToolbarSkeleton />
      <TableSkeleton rows={15} />
    </div>
  );
}
