import {
  PageTitleSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

export default function DepositsTransactionsLoading() {
  return (
    <div className="space-y-4">
      <PageTitleSkeleton width={110} />
      <ToolbarSkeleton />
      <TableSkeleton rows={15} />
    </div>
  );
}
