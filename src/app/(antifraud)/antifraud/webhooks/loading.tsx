import { PageHeroSkeleton } from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function WebhooksLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <Skeleton className="h-16 rounded-xl" />
      <Skeleton className="h-[420px] rounded-xl" />
    </div>
  );
}
