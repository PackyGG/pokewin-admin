import {
  KpiStripSkeleton,
  PageHeroSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";
import { SkeletonTable } from "@/components/ux";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Matches /vips: hero, 5-tile KPI strip, "VIP accounts" section heading,
 * VIP roster table (Player / Discord / Lifetime PnL / Deposits /
 * Withdrawals / Country / Tagged at — 7 columns), and the bot-activity
 * feed below. Shape mirrors page.tsx 1:1 so the real content swaps in
 * without layout jump.
 */
export default function VipsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <KpiStripSkeleton count={5} />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={140} />
        <SkeletonTable rows={8} columns={7} rowHeight={52} />
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={160} />
        <div className="rounded-2xl border bg-card p-4">
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full rounded" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
