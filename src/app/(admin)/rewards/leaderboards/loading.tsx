import {
  PageTitleSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function LeaderboardsLoading() {
  return (
    <div className="space-y-4">
      <PageTitleSkeleton width={140} />
      <Skeleton className="h-10 w-full max-w-md" />
      <TableSkeleton rows={10} />
    </div>
  );
}
