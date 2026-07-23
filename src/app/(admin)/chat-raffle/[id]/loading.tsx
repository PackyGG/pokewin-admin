import {
  PageHeroSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { SkeletonTable } from "@/components/ux";

/** Matches /chat-raffle/[id]: hero, round heading, KPI strip, snapshot. */
export default function ChatRaffleRoundLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="space-y-4">
        <SectionHeadingSkeleton titleWidth={220} />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-2xl" />
          ))}
        </div>
        <SkeletonTable rows={8} columns={4} rowHeight={36} />
      </div>
    </div>
  );
}
