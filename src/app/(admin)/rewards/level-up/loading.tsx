import {
  PageTitleSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

export default function LevelUpLoading() {
  return (
    <div className="space-y-4">
      <PageTitleSkeleton width={100} />
      <TableSkeleton rows={12} />
    </div>
  );
}
