import { PageHeroSkeleton } from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/** Matches /antifraud/notifications: hero, count row, the inbox list. */
export default function NotificationsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <div className="overflow-hidden rounded-xl border border-border/60">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-none" />
          ))}
        </div>
      </div>
    </div>
  );
}
