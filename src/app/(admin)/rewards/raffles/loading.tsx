import {
  PageTitleSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function RafflesLoading() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <PageTitleSkeleton width={100} />
        <Skeleton className="h-9 w-[140px]" />
      </div>
      <Skeleton className="h-10 w-full max-w-md" />
      <TableSkeleton rows={10} />
    </div>
  );
}
