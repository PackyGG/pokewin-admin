import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";
import { SkeletonText } from "@/components/ux";

/**
 * Route-level loading skeleton for /system/monitor. Keeps the shell painted
 * immediately while the Server Component fetches the live monitor overview
 * (a single backend round-trip, capped at the helper's 8s timeout). Mirrors
 * the page chrome: hero + 6-tile KPI strip, then the Service / Notifications
 * / Analytics section silhouettes.
 */
export default function MonitorLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <KpiStripSkeleton count={6} />

      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={140} />
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border bg-card p-4 ring-1 ring-foreground/10 sm:p-5">
            <SkeletonText lines={5} />
          </div>
          <div className="rounded-xl border bg-card p-4 ring-1 ring-foreground/10 sm:p-5">
            <SkeletonText lines={3} />
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={180} />
        <div className="rounded-2xl border bg-card p-4 ring-1 ring-foreground/10 sm:p-5">
          <SkeletonText lines={6} />
        </div>
      </div>

      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={150} />
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border bg-card p-4 ring-1 ring-foreground/10 sm:p-5">
            <SkeletonText lines={4} />
          </div>
          <div className="rounded-xl border bg-card p-4 ring-1 ring-foreground/10 sm:p-5">
            <SkeletonText lines={5} />
          </div>
        </div>
      </div>
    </div>
  );
}
