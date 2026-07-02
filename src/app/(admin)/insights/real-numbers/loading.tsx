import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for /insights/real-numbers — keeps the shell
 * (PageHero) + tab-nav painted immediately while the active tab's Server
 * Component resolves.
 *
 * TAB-AGNOSTIC by design: the page has three tabs of very different heights
 * (Analytics = a light 3-tile strip, Real Numbers / Player CRM = tall multi-
 * section bodies). A deep link can land on any of them, so this route-level
 * skeleton — which renders before we know which tab is active — mirrors only
 * the always-present chrome (hero → tab-nav pill row → one neutral KPI strip
 * → one neutral section placeholder). It approximates every tab without
 * committing to one tab's shape, so nothing jumps hard when the real body
 * (and its own per-tab `<Suspense>` fallback) streams in. The precise per-tab
 * silhouettes live in each tab's own Suspense fallback in `page.tsx`.
 */
export default function RealNumbersLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />

      {/* Tab-nav pill row — mirrors the 3-pill RealNumbersTabNav container. */}
      <Skeleton className="h-10 w-full max-w-md rounded-lg" />

      {/* Neutral body silhouette — a KPI strip + one section placeholder that
          fits all three tabs approximately (each tab opens with tiles and/or a
          section). Kept deliberately generic so no single tab's exact shape is
          assumed. */}
      <div className="space-y-6">
        <KpiStripSkeleton count={4} />
        <div className="space-y-3">
          <SectionHeadingSkeleton titleWidth={220} />
          <Skeleton className="h-48 w-full rounded-2xl" />
        </div>
      </div>
    </div>
  );
}
