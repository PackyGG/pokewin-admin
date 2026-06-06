import {
  PageHeroSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for the Creator Hub → Creator Check page. Keeps
 * the Hub chrome visible on a cold navigation while the saved-profile history
 * (an ADMIN-DB substrate read) resolves. The in-page `<Suspense>` covers any
 * subsequent revalidate; this only renders on the first paint of a cold nav.
 *
 * Mirrors the page chrome: the hero (with the "+ Check Creator" action), the
 * 4 KPI tiles, then the Kick + Twitter section headings each with a 3-up grid
 * of profile-box placeholders.
 */
export default function CreatorCheckLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />

      {/* KPI strip — 4 tiles. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[88px] rounded-xl" />
        ))}
      </div>

      {/* Two platform sections, each a 3-up grid of profile boxes. */}
      {Array.from({ length: 2 }).map((_, section) => (
        <div key={section} className="space-y-3">
          <SectionHeadingSkeleton titleWidth={120} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-[150px] rounded-xl" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
