import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";
import { SkeletonChart, SkeletonText } from "@/components/ux";

/**
 * Route-level loading skeleton — keeps the shell visible while the
 * Server Component resolves the cost-breakdown aggregation (which fans
 * out to the Money Flow decomposition + the contributor sweep). On the
 * lifetime window these are the heaviest queries, so a skeleton beats a
 * blank screen.
 *
 * Mirrors the real page chrome 1:1 — hero (with period-filter action),
 * a 4-tile KPI strip, the daily-cost trend chart, and the waterfall
 * panel — using layout-matching silhouettes so nothing jumps when the
 * data lands.
 */
export default function Loading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <KpiStripSkeleton count={4} />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={200} />
        <SkeletonChart height={360} variant="area" title={false} />
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={180} />
        <div className="rounded-2xl border bg-card p-4 sm:p-5">
          <SkeletonText lines={10} />
        </div>
      </div>
    </div>
  );
}
