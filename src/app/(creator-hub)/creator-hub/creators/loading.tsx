import { SectionHeadingSkeleton } from "@/components/loading-skeletons";

import {
  RosterListSkeleton,
  RosterToolbarSkeleton,
} from "./_components/roster-skeletons";

/**
 * Route-level loading skeleton for Creator Hub → Creators roster. Mirrors
 * the real page: section heading, the single toolbar row (tabs + period +
 * search + sort + view + add), then the meta line + card grid. No hero —
 * the page doesn't render one.
 */
export default function CreatorHubRosterLoading() {
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={120} />
        <div className="space-y-4">
          <RosterToolbarSkeleton />
          <RosterListSkeleton />
        </div>
      </div>
    </div>
  );
}
