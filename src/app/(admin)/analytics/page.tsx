import { BarChart3 } from "lucide-react";
import { Suspense } from "react";
import { requirePageAccess } from "@/lib/dal";
import { AutoRefresh } from "../dashboard/auto-refresh";
import { PeriodFilter } from "./period-filter";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { AnalyticsTabNav, type AnalyticsTab } from "./tab-nav";
import { parsePeriod } from "./types";
import { OverviewTab } from "./tab-overview";
import { PurePnlTab } from "./tab-pure-pnl";
import { CohortsTab } from "./tab-cohorts";
import { FunnelTab } from "./tab-funnel";
import { LtvTab } from "./tab-ltv";
import { RetentionTab } from "./tab-retention";
import { RevenueTab } from "./tab-revenue";
import { TopPerformersTab } from "./tab-top";
import { HeatmapTab } from "./tab-heatmap";
import { PacksBattlesTab } from "./tab-packs";
import { MapTab } from "./tab-map";
import { parseMetric } from "./map/utils";
import { TabSkeleton, TabSkeletonBars, TabSkeletonTable } from "./tab-skeleton";
import type { ReactNode } from "react";
import type { CohortGranularity } from "@/lib/queries/analytics-cohorts";

export const metadata = { title: "Analytics" };

function parseTab(value: string | undefined): AnalyticsTab {
  switch (value) {
    case "overview":
    case "pure-pnl":
    case "cohorts":
    case "funnel":
    case "ltv":
    case "retention":
    case "revenue":
    case "top":
    case "heatmap":
    case "packs":
    case "map":
      return value;
    default:
      return "overview";
  }
}

function parseCohortBy(value: string | undefined): CohortGranularity {
  return value === "month" ? "month" : "week";
}

/**
 * Pick the Suspense fallback that matches the active tab's real shape, so
 * the swap from skeleton → content doesn't jump the layout:
 *   • funnel        → stacked horizontal bars (mirrors `FunnelBars`)
 *   • top/ltv/packs → KPI strip + data table (leaderboard-style tabs)
 *   • everything else (overview, map, cohorts, retention, revenue,
 *     heatmap, pure-pnl) → KPIs + chart (the dominant shape).
 */
function fallbackForTab(tab: AnalyticsTab): ReactNode {
  switch (tab) {
    case "funnel":
      return <TabSkeletonBars />;
    case "top":
    case "ltv":
    case "packs":
      return <TabSkeletonTable />;
    default:
      return <TabSkeleton />;
  }
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/analytics");
  const params = await searchParams;
  const period = parsePeriod(params.period);
  const tab = parseTab(params.tab);
  const cohortBy = parseCohortBy(params.cohortBy);
  const topTab = params.topTab;
  const packsSort = params.packsSort;
  // Map tab uses its own URL param for the heat metric (users /
  // deposits / wagers / multiplier). Parsed here so the param flows
  // into the Suspense key and the tab segment re-renders when the
  // user toggles metrics.
  const mapMetric = parseMetric(params.metric);

  return (
    <div className="space-y-6">
      {/* Analytics polls at 300s — cohorts/funnel/LTV move on hour/day
          boundaries, not seconds. Use the period/tab navigation to
          force a fresh fetch when needed. */}
      <AutoRefresh intervalMs={300_000} />
      <PageHero>
        {/* Identity + period filter stack vertically on phones — the
            5-chip filter would otherwise wrap awkwardly under the
            icon. At sm+ they go side-by-side so the hero scans cleanly
            on tablets and desktops. Shared PageHeroIdentity primitive so
            the icon chip, title ladder, and action slot match every
            other admin hero. */}
        <PageHeroIdentity
          icon={BarChart3}
          title="Analytics"
          subtitle="Revenue, acquisition, and gameplay metrics over time."
          action={<PeriodFilter />}
        />
      </PageHero>

      <AnalyticsTabNav />

      {/* Each tab is an independent async segment. We render only the one
          that matches `tab` so nothing else hits the DB — important because
          several of these tabs run heavy raw SQL. Suspense + per-tab skeleton
          keeps navigation snappy between tabs. The fallback matches each
          tab's real shape (bars for the funnel, a table for the leaderboard-
          style tabs, KPIs+chart for the rest) so the swap into real content
          doesn't jump the layout. */}
      <Suspense
        key={`${tab}-${period}-${cohortBy}-${topTab ?? ""}-${packsSort ?? ""}-${mapMetric}`}
        fallback={fallbackForTab(tab)}
      >
        {tab === "overview" && <OverviewTab period={period} />}
        {tab === "pure-pnl" && <PurePnlTab />}
        {tab === "cohorts" && (
          <CohortsTab period={period} granularity={cohortBy} />
        )}
        {tab === "funnel" && <FunnelTab period={period} />}
        {tab === "ltv" && <LtvTab period={period} />}
        {tab === "retention" && <RetentionTab period={period} />}
        {tab === "revenue" && <RevenueTab period={period} />}
        {tab === "top" && (
          <TopPerformersTab period={period} subTab={topTab} />
        )}
        {tab === "heatmap" && <HeatmapTab period={period} />}
        {tab === "packs" && (
          <PacksBattlesTab period={period} sortKey={packsSort} />
        )}
        {tab === "map" && <MapTab period={period} metric={mapMetric} />}
      </Suspense>
    </div>
  );
}
