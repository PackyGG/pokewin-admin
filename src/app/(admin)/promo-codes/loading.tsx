import {
  PageTitleSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

export default function PromoCodesLoading() {
  return (
    <div className="space-y-4">
      <PageTitleSkeleton width={140} />
      <ToolbarSkeleton />
      <TableSkeleton rows={12} />
    </div>
  );
}
