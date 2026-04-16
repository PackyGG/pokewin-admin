import {
  PageTitleSkeleton,
  FormCardSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

export default function RainLoading() {
  return (
    <div className="space-y-6">
      <PageTitleSkeleton width={80} />
      <FormCardSkeleton rows={3} />
      <TableSkeleton rows={10} />
    </div>
  );
}
