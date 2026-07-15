import {
  PageHeroSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";
import { SkeletonTable } from "@/components/ux";

/**
 * Matches /top-chatters: hero, "Today's chat leaderboard" section heading,
 * ranked chatter list. Shape mirrors page.tsx so the real content swaps in
 * without layout jump.
 */
export default function TopChattersLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={180} />
        <SkeletonTable rows={10} columns={4} rowHeight={40} />
      </div>
    </div>
  );
}
