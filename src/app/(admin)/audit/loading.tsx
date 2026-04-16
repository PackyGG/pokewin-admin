import {
  PageTitleSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

export default function AuditLoading() {
  return (
    <div className="space-y-4">
      <PageTitleSkeleton width={100} />
      <ToolbarSkeleton />
      <TableSkeleton rows={15} />
    </div>
  );
}
