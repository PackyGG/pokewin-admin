import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { TableSkeleton } from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function RefundsLoading() {
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>
      <Skeleton className="h-28 w-full rounded-xl" />
      <TableSkeleton rows={8} columns={4} />
    </div>
  );
}
