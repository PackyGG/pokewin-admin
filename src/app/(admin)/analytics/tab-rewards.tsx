import { Suspense } from "react";
import { ExportButton } from "@/components/export-button";
import {
  parseInsightsRewardsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { InsightsRewardsPeriodFilter } from "../insights/rewards/_components/period-filter";
import { InsightsRewardsTabSwitch } from "../insights/rewards/_components/tab-switch";
import {
  InsightsRewardsTabSkeleton,
  InsightsRewardsCompactTabSkeleton,
} from "../insights/rewards/_components/tab-skeleton";
import { OverviewTab } from "../insights/rewards/_components/overview-tab";
import { DailyPacksTab } from "../insights/rewards/_components/daily-packs-tab";
import { CategoriesTab } from "../insights/rewards/_components/categories-tab";
import { RoiTab } from "../insights/rewards/_components/roi-tab";
import { RetentionTab } from "../insights/rewards/_components/retention-tab";
import { StackingTab } from "../insights/rewards/_components/stacking-tab";
import { CohortTab } from "../insights/rewards/_components/cohort-tab";
import { TopSpendersTab } from "../insights/rewards/_components/top-spenders-tab";
import { ForecastTab } from "../insights/rewards/_components/forecast-tab";
import { GeoTab } from "../insights/rewards/_components/geo-tab";

type Tab =
  | "overview"
  | "daily-packs"
  | "categories"
  | "roi"
  | "retention"
  | "stacking"
  | "cohort"
  | "top"
  | "forecast"
  | "geo";

function parseTab(value: string | undefined): Tab {
  switch (value) {
    case "daily-packs":
    case "categories":
    case "roi":
    case "retention":
    case "stacking":
    case "cohort":
    case "top":
    case "forecast":
    case "geo":
      return value;
    default:
      return "overview";
  }
}

/**
 * /insights/rewards — full-spectrum cross-reward analytics.
 *
 * Sits in the Insights sidebar group alongside Analytics / Games /
 * Streamers (each is a cross-cutting deep-dive page that subsumes a
 * thinner per-feature equivalent).
 *
 * The existing /rewards/analytics page stays as the per-category
 * deep-stats hub (one tab per category). This page sits ON TOP of it
 * and adds the cross-category layer:
 *
 *   1. Overview     — total spend, ROI vs platform GGR, period delta.
 *   2. Daily Packs  — free / daily reward-pack (pack_type='reward')
 *                     giveaway cost: value of cards handed out for ~$0
 *                     wager, a house cost no other reward surface counts.
 *   3. Categories   — per-category deep stats reusing the existing
 *                     `rewards-category-analytics` + `rewards-category-extras`
 *                     helpers + the shared CategoryDeepStatsPanel.
 *   4. ROI          — cost in window vs claimants' subsequent GGR.
 *   5. Retention    — claimants vs non-claimants 7d / 30d retention.
 *   6. Stacking     — multi-category claimants + LTV lift.
 *   7. Cohort       — signup cohort × reward usage × LTV.
 *   8. Top spenders — top 25 reward recipients across categories.
 *   9. Forecast     — 60d historical + 30d run-rate projection.
 *  10. Geo / Source — reward distribution by country / signup source.
 *
 * Period selector exposes 24h / 3d / 7d / 30d / 90d / lifetime —
 * wider than /rewards/analytics so admins can sanity-check shorter
 * spikes against longer trends without leaving the page.
 *
 * House-POV everywhere: rewards are house cost → rose. ROI flips
 * emerald when subsequent gameplay GGR exceeds spend, rose otherwise.
 */
/**
 * Rewards Insights as an /analytics tab.
 *
 * Was `/insights/rewards` (owner, 2026-07-23). Body untouched; the PageHero
 * is gone (analytics renders one) and the period filter + export moved inline.
 *
 * Params are re-namespaced so the outer analytics tab bar and this one don't
 * fight: `?rw=` picks the sub-view (was `?tab=`), `?rwPeriod=` the window (was
 * `?period=`, which /analytics owns with a different vocabulary).
 */
export async function RewardsInsightsTab({
  period,
  sub,
}: {
  period: ReturnType<typeof parseInsightsRewardsPeriod>;
  sub: string | undefined;
}) {
  const tab = parseTab(sub);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Cross-reward analysis, ROI, retention impact, cohort lift, marketing
          cost vs revenue.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <InsightsRewardsPeriodFilter />
          <ExportButton page="rewards" params={{ period }} />
        </div>
      </div>

      <InsightsRewardsTabSwitch />

      {/* Suspense keyed on (tab, period) — flipping either re-renders
          the skeleton instead of stalling on stale numbers. Each tab
          is its own async server component that fetches its own data;
          the cached query layer absorbs the round-trip cost. */}
      <Suspense
        key={`${tab}:${period}`}
        fallback={
          tab === "stacking" || tab === "cohort"
            ? <InsightsRewardsCompactTabSkeleton />
            : <InsightsRewardsTabSkeleton />
        }
      >
        <TabContent tab={tab} period={period} />
      </Suspense>
    </div>
  );
}

async function TabContent({
  tab,
  period,
}: {
  tab: Tab;
  period: InsightsRewardsPeriod;
}) {
  switch (tab) {
    case "overview":
      return <OverviewTab period={period} />;
    case "daily-packs":
      return <DailyPacksTab period={period} />;
    case "categories":
      return <CategoriesTab period={period} />;
    case "roi":
      return <RoiTab period={period} />;
    case "retention":
      return <RetentionTab period={period} />;
    case "stacking":
      return <StackingTab period={period} />;
    case "cohort":
      return <CohortTab period={period} />;
    case "top":
      return <TopSpendersTab period={period} />;
    case "forecast":
      return <ForecastTab period={period} />;
    case "geo":
      return <GeoTab period={period} />;
  }
}
