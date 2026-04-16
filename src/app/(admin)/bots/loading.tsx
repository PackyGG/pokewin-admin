import {
  PageTitleSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

export default function BotsLoading() {
  return (
    <div className="space-y-4">
      <PageTitleSkeleton width={80} />
      <TableSkeleton rows={6} />
    </div>
  );
}
