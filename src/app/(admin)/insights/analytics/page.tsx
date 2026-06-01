import { Suspense } from "react";
import { Telescope } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { parseInsightsPeriod, parseInsightsTab } from "./types";
import { PeriodSelector } from "./period-selector";
import { InsightsTabNav } from "./tab-nav";
import { InsightsTabSkeleton } from "./tab-skeleton";
import { OverviewInsightsTab } from "./tab-overview";
import { CohortsInsightsTab } from "./tab-cohorts";
import { RetentionInsightsTab } from "./tab-retention";
import { LtvInsightsTab } from "./tab-ltv";
import { FunnelInsightsTab } from "./tab-funnel";
import { HeatmapInsightsTab } from "./tab-heatmap";
import { WhalesInsightsTab } from "./tab-whales";
import { GeoInsightsTab } from "./tab-geo";
import { SourcesInsightsTab } from "./tab-sources";
import { MoneyFlowInsightsTab } from "./tab-money-flow";

export const metadata = { title: "Analytics Insights" };

/**
 * /insights/analytics — the deep-dive analytics surface. Separate from
 * the legacy /analytics page (which stays as-is). Tabs:
 *   • Overview   — period KPIs + sparklines + delta vs previous period
 *   • Cohorts    — signup cohort retention / revenue trajectories
 *   • Retention  — Day 1/7/30/90 retention curves with breakdowns
 *   • LTV        — lifetime value segmented by percentile + components
 *   • Funnel     — click → signup → deposit → wager → repeat → MAW
 *   • Heatmap    — hour-of-week activity heatmap, multi-metric
 *   • Whales     — multi-lens top-20 (lifetime, 7d, biggest single)
 *   • Geo        — country / region breakdowns
 *   • Sources    — signup source split, with cohort metrics per source
 *   • Money Flow — decomposes the GGR ↔ P&L gap explicitly (card
 *                  withdrawals + inventory growth + voucher growth +
 *                  residual). Answers "why was GGR $290k but P&L only
 *                  $17k?" without changing the canonical formulas.
 */
export default async function InsightsAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/insights/analytics");
  const params = await searchParams;
  const period = parseInsightsPeriod(params.period);
  const tab = parseInsightsTab(params.tab);

  // Per-tab sub-params — pass through to the tab segment as needed so
  // sub-controls (whalesBy, geoBy, sourcesBy, …) survive period swaps.
  const whalesBy = params.whalesBy;
  const cohortsBy = params.cohortsBy;
  const heatmapMetric = params.heatmapMetric;
  const retentionBy = params.retentionBy;
  const funnelBy = params.funnelBy;
  const sourcesBy = params.sourcesBy;
  const geoBy = params.geoBy;
  const ltvBy = params.ltvBy;

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <PageHeroIdentity
            icon={Telescope}
            title="Analytics Insights"
            subtitle="Deep cohort, retention, funnel, and LTV analysis across the whole platform"
            accent="cyan"
          />
          <PeriodSelector />
        </div>
      </PageHero>

      <InsightsTabNav />

      {/* One async segment per tab — only the active one mounts so the
          unrelated tabs don't touch the DB. Suspense + skeleton keeps
          the page responsive while heavy raw SQL runs. The key includes
          every sub-param so a sub-control switch (e.g. whalesBy) forces
          a fresh fetch even within the same tab. */}
      <Suspense
        key={`${tab}-${period}-${whalesBy ?? ""}-${cohortsBy ?? ""}-${heatmapMetric ?? ""}-${retentionBy ?? ""}-${funnelBy ?? ""}-${sourcesBy ?? ""}-${geoBy ?? ""}-${ltvBy ?? ""}`}
        fallback={<InsightsTabSkeleton />}
      >
        {tab === "overview" && <OverviewInsightsTab period={period} />}
        {tab === "cohorts" && (
          <CohortsInsightsTab period={period} granularity={cohortsBy} />
        )}
        {tab === "retention" && (
          <RetentionInsightsTab period={period} breakdownBy={retentionBy} />
        )}
        {tab === "ltv" && <LtvInsightsTab period={period} segmentBy={ltvBy} />}
        {tab === "funnel" && (
          <FunnelInsightsTab period={period} breakdownBy={funnelBy} />
        )}
        {tab === "heatmap" && (
          <HeatmapInsightsTab period={period} metric={heatmapMetric} />
        )}
        {tab === "whales" && <WhalesInsightsTab period={period} subTab={whalesBy} />}
        {tab === "geo" && <GeoInsightsTab period={period} groupBy={geoBy} />}
        {tab === "sources" && (
          <SourcesInsightsTab period={period} subTab={sourcesBy} />
        )}
        {tab === "money-flow" && <MoneyFlowInsightsTab period={period} />}
      </Suspense>
    </div>
  );
}
