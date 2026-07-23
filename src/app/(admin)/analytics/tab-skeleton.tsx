import { SkeletonKpiStrip, SkeletonChart } from "@/components/ux";

/**
 * Suspense fallback for the analytics tab segment.
 *
 * There used to be three variants — KPIs + chart, a stack of horizontal bars
 * (funnel) and a data table (top performers / LTV / packs) — because the tabs
 * were shaped very differently. The bars and table variants went out with the
 * tabs they matched; every surviving tab leads with KPIs over a chart, so one
 * shape covers them all and `page.tsx` no longer selects per tab.
 */
export function TabSkeleton() {
  return (
    <div className="space-y-4">
      <SkeletonKpiStrip count={6} />
      <SkeletonChart height={384} variant="area" />
    </div>
  );
}
