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
import { DoubleDownTab } from "./tab-double-down";
import { RealNumbersTab } from "./tab-real-numbers";
import { CostBreakdownTab } from "./tab-cost-breakdown";
import { RewardsInsightsTab } from "./tab-rewards";
import { parseInsightsPeriod } from "@/lib/queries/insights-analytics/period";
import { parseInsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import { RevenueTab } from "./tab-revenue";
import { TopPerformersTab } from "./tab-top";
import { HeatmapTab } from "./tab-heatmap";
import { PacksBattlesTab } from "./tab-packs";
import { MapTab } from "./tab-map";
import { parseMetric } from "./map/utils";
import { TabSkeleton, TabSkeletonTable } from "./tab-skeleton";
import type { ReactNode } from "react";

export const metadata = { title: "Analytics" };

// A deleted tab's URL (?tab=cohorts, funnel, ltv, retention) falls through
// to Overview rather than 404-ing — a stale bookmark lands somewhere useful.
function parseTab(value: string | undefined): AnalyticsTab {
  switch (value) {
    case "overview":
    case "pure-pnl":
    case "real-numbers":
    case "cost-breakdown":
    case "rewards":
    case "double-down":
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

/**
 * Pick the Suspense fallback that matches the active tab's real shape, so
 * the swap from skeleton → content doesn't jump the layout:
 *   • top/packs → KPI strip + data table (leaderboard-style tabs)
 *   • everything else (overview, map, revenue, heatmap, pure-pnl) →
 *     KPIs + chart (the dominant shape).
 */
function fallbackForTab(tab: AnalyticsTab): ReactNode {
  switch (tab) {
    case "top":
    case "packs":
      return <TabSkeletonTable />;
    default:
      return <TabSkeleton />;
  }
}

/**
 * Tabs whose content is actually keyed on the page-level `?period=`. Every
 * other tab either fixes its own window or ships its own filter, so the
 * global one is hidden rather than left inert.
 */
const PERIOD_DRIVEN_TABS = new Set<AnalyticsTab>([
  "overview",
  "revenue",
  "top",
  "heatmap",
  "packs",
  "map",
]);

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/analytics");
  const params = await searchParams;
  const period = parsePeriod(params.period);
  const tab = parseTab(params.tab);
  const topTab = params.topTab;
  // Double Down tab params (absorbed from /insights/double-down): `q` is the
  // audit-log search, `page` its pagination. Parsed defensively — a fuzzed
  // ?page= must never reach the query's OFFSET.
  const ddSearch = (params.q ?? "").trim();
  const ddPageRaw = Number.parseInt(params.page ?? "1", 10);
  const ddPage = Number.isFinite(ddPageRaw) && ddPageRaw > 0 ? ddPageRaw : 1;
  // Absorbed-tab params, each namespaced so no two tab bars write the same
  // key: `rn` = Real Numbers sub-view, `cbPeriod` = Cost Breakdown window,
  // `rw` / `rwPeriod` = Rewards sub-view + window.
  const rnSub = params.rn;
  const cbPeriod = parseInsightsPeriod(params.cbPeriod);
  const rwSub = params.rw;
  const rwPeriod = parseInsightsRewardsPeriod(params.rwPeriod);
  const packsSort = params.packsSort;
  // Map tab uses its own URL param for the heat metric (users /
  // deposits / wagers / multiplier). Parsed here so the param flows
  // into the Suspense key and the tab segment re-renders when the
  // user toggles metrics.
  const mapMetric = parseMetric(params.metric);

  return (
    <div className="space-y-6">
      {/* Analytics polls at 300s — these aggregates move on hour/day
          boundaries, not seconds. Use the period/tab navigation to
          force a fresh fetch when needed. */}
      <AutoRefresh intervalMs={300_000} />
      <PageHero>
        <PageHeroIdentity
          icon={BarChart3}
          title="Analytics"
          subtitle="Revenue, acquisition, and gameplay metrics over time."
        />
      </PageHero>

      {/* Period filter rides the tab row instead of the hero (owner,
          2026-07-23: the page was wasting height). On phones the hero used to
          stack identity + a 5-chip filter vertically, costing a whole row
          before any data; here it sits at the end of a row that already
          exists. The tab strip keeps its own horizontal scroll, so the filter
          stays pinned and visible however many tabs there are.

          It renders ONLY on tabs the page-level `?period=` actually drives.
          Double Down is locked to 30d, Real Numbers is lifetime, and Cost
          Breakdown / Rewards carry their own period control inside the tab —
          showing a global filter there would be a dead knob. */}
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <AnalyticsTabNav />
        </div>
        {PERIOD_DRIVEN_TABS.has(tab) && (
          <div className="shrink-0">
            <PeriodFilter />
          </div>
        )}
      </div>

      {/* Each tab is an independent async segment. We render only the one
          that matches `tab` so nothing else hits the DB — important because
          several of these tabs run heavy raw SQL. Suspense + per-tab skeleton
          keeps navigation snappy between tabs. The fallback matches each
          tab's real shape (a table for the leaderboard-style tabs, KPIs +
          chart for the rest) so the swap into real content doesn't jump the
          layout. */}
      <Suspense
        key={`${tab}-${period}-${topTab ?? ""}-${packsSort ?? ""}-${mapMetric}-${ddSearch}-${ddPage}-${rnSub ?? ""}-${cbPeriod}-${rwSub ?? ""}-${rwPeriod}`}
        fallback={fallbackForTab(tab)}
      >
        {tab === "overview" && <OverviewTab period={period} />}
        {tab === "pure-pnl" && <PurePnlTab />}
        {tab === "double-down" && (
          <DoubleDownTab search={ddSearch} page={ddPage} />
        )}
        {tab === "real-numbers" && <RealNumbersTab sub={rnSub} />}
        {tab === "cost-breakdown" && <CostBreakdownTab period={cbPeriod} />}
        {tab === "rewards" && (
          <RewardsInsightsTab period={rwPeriod} sub={rwSub} />
        )}
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
