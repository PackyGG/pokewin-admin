import {
  PageTitleSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

export default function SecurityLoading() {
  return (
    <div className="space-y-4">
      <PageTitleSkeleton width={100} />
      <TableSkeleton rows={10} />
    </div>
  );
}
