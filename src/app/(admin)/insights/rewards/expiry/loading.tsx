import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  StatPanelSkeleton,
} from "@/components/loading-skeletons";

/**
 * Route-level loading skeleton for /insights/rewards/expiry — keeps the
 * shell visible on a cold navigation while the server component resolves.
 * The in-page `<Suspense key={period}>` handles post-mount period swaps;
 * this only renders on the first paint of a cold nav. Mirrors the page
 * chrome (hero + period filter) over the model-gap notice + config panels
 * + forfeited KPI strip so nothing jumps when the real body lands.
 */
export default function RewardExpiryLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <div className="h-24 rounded-2xl border border-amber-500/30 bg-amber-500/10" />
      <div className="grid gap-3 sm:grid-cols-3">
        <StatPanelSkeleton />
        <StatPanelSkeleton />
        <StatPanelSkeleton />
      </div>
      <KpiStripSkeleton count={3} />
    </div>
  );
}
