import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  StatPanelSkeleton,
  ChartSkeleton,
} from "@/components/loading-skeletons";

/**
 * Mirrors /system/stats: hero, KPI strip, and five sections (query perf,
 * admin activity w/ chart, session health KPIs, data freshness, DB sizes,
 * build info). Matches shape so swap-in is jump-free.
 */
export default function SystemStatsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <KpiStripSkeleton count={4} />

      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={160} />
        <div className="grid gap-4 lg:grid-cols-3">
          <StatPanelSkeleton rows={4} />
          <StatPanelSkeleton rows={4} />
          <StatPanelSkeleton rows={4} />
        </div>
      </div>

      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={120} />
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <ChartSkeleton height={260} />
          </div>
          <StatPanelSkeleton rows={5} />
        </div>
        <StatPanelSkeleton rows={5} />
      </div>

      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={140} />
        <KpiStripSkeleton count={4} />
      </div>

      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={140} />
        <StatPanelSkeleton rows={2} />
      </div>

      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={140} />
        <div className="grid gap-4 lg:grid-cols-2">
          <StatPanelSkeleton rows={6} />
          <StatPanelSkeleton rows={3} />
        </div>
      </div>

      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={100} />
        <StatPanelSkeleton rows={6} />
      </div>
    </div>
  );
}
