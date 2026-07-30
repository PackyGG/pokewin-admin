import { PageHeroSkeleton } from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Matches /antifraud/fiat-eligibility: hero + title block, the 4-tile KPI strip
 * and the stacked rule sections.
 *
 * The page body is static reference copy, but reaching it still awaits
 * `requireAntifraudManagerPage()` — a per-role Admin-DB access read. Without a
 * `loading.tsx` that gate is dead time: the sidebar highlights the new route and
 * nothing else changes until the read returns. This gives the navigation an
 * immediate frame.
 */
export default function FiatEligibilityLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />

      <div className="space-y-3">
        <Skeleton className="h-8 w-80" />
        <Skeleton className="h-10 w-full max-w-3xl" />
      </div>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-24 rounded-xl" />
        ))}
      </div>

      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="space-y-3">
          <Skeleton className="h-7 w-64" />
          <Skeleton className="h-56 w-full rounded-xl" />
        </div>
      ))}
    </div>
  );
}
