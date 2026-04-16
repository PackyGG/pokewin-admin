import {
  PageTitleSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

export default function PacksLoading() {
  return (
    <div className="space-y-4">
      <PageTitleSkeleton width={100} />
      <ToolbarSkeleton />
      <TableSkeleton rows={12} />
    </div>
  );
}
