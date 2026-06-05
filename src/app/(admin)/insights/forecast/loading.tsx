import { PageHeroSkeleton } from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { ForecastHubSkeleton } from "./_skeleton";

/**
 * Route-level loading skeleton for /insights/forecast — keeps the shell
 * visible on a cold navigation while the selected reward's baseline
 * resolves. The per-reward `<Suspense>` in page.tsx handles post-mount
 * reward/period swaps; this only renders on the first paint of a cold nav.
 *
 * Mirrors the page chrome: the hero (with the period-filter action), the
 * reward-picker pill row + the one-line blurb under it, then the selected
 * reward's forecast island — reusing the page's own `ForecastHubSkeleton`
 * (KPI strip + controls rail + chart grid + comparison table) so nothing
 * jumps when the data lands. The picker reproduces the page's
 * `flex flex-wrap gap-1.5` row of 8 reward pills.
 */
export default function ForecastHubLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />

      {/* Reward picker + blurb line. */}
      <div className="space-y-2">
        <div className="flex flex-wrap gap-1.5">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-24 rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-3 w-72 rounded" />
      </div>

      <ForecastHubSkeleton />
    </div>
  );
}
