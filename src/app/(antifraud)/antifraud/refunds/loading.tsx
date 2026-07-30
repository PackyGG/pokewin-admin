import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { TableSkeleton } from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function RefundsLoading() {
  return (
    <div className="space-y-4">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Skeleton className="size-7 rounded-lg" />
          <Skeleton className="h-4 w-56" />
        </div>
        <Skeleton className="h-28 w-full rounded-xl" />
        <TableSkeleton rows={8} columns={4} />
      </div>
    </div>
  );
}
