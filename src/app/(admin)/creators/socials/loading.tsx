import { PageHeroSkeleton } from "@/components/loading-skeletons";

import { SocialsQueueCardSkeleton } from "./queue-skeleton";

/**
 * Route-level loading skeleton for /creators/socials — keeps the shell
 * visible on a cold navigation while the social-submission queue resolves
 * (a backend-API read that can be slow / unavailable).
 *
 * Mirrors the page chrome 1:1: the hero (with the trailing "Total in
 * queue" KPI tile reserved via the action slot), then the queue card —
 * the status-tab row + "showing N of M" line at the top, and the list of
 * submission rows (avatar + creator/handle + badges + actions) below. The
 * card body is shared with the page's own <Suspense> fallback so a cold nav
 * and a status flip look identical.
 */
export default function CreatorSocialsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <SocialsQueueCardSkeleton />
    </div>
  );
}
