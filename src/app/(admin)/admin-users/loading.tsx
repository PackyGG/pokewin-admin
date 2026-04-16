import {
  PageTitleSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

export default function AdminUsersLoading() {
  return (
    <div className="space-y-4">
      <PageTitleSkeleton width={160} />
      <ToolbarSkeleton />
      <TableSkeleton rows={10} />
    </div>
  );
}
