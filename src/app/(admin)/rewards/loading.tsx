import {
  PageTitleSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

export default function RewardsLoading() {
  return (
    <div className="space-y-4">
      <PageTitleSkeleton width={120} />
      <ToolbarSkeleton />
      <TableSkeleton rows={10} />
    </div>
  );
}
