import {
  PageTitleSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

export default function BattleTransactionsLoading() {
  return (
    <div className="space-y-4">
      <PageTitleSkeleton width={180} />
      <ToolbarSkeleton />
      <TableSkeleton rows={15} />
    </div>
  );
}
