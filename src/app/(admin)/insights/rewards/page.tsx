import { Suspense } from "react";
import { Gift } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import {
  PageHero,
  PageHeroIdentity,
} from "@/components/modern-panels";
import { ExportButton } from "@/components/export-button";
import {
  parseInsightsRewardsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { InsightsRewardsPeriodFilter } from "./_components/period-filter";
import { InsightsRewardsTabSwitch } from "./_components/tab-switch";
import {
  InsightsRewardsTabSkeleton,
  InsightsRewardsCompactTabSkeleton,
} from "./_components/tab-skeleton";
import { OverviewTab } from "./_components/overview-tab";
import { DailyPacksTab } from "./_components/daily-packs-tab";
import { CategoriesTab } from "./_components/categories-tab";
import { RoiTab } from "./_components/roi-tab";
import { RetentionTab } from "./_components/retention-tab";
import { StackingTab } from "./_components/stacking-tab";
import { CohortTab } from "./_components/cohort-tab";
import { TopSpendersTab } from "./_components/top-spenders-tab";
import { ForecastTab } from "./_components/forecast-tab";
import { GeoTab } from "./_components/geo-tab";

export const metadata = { title: "Rewards Insights" };

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
export default async function InsightsRewardsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/insights/rewards");
  const params = await searchParams;
  const period = parseInsightsRewardsPeriod(params.period);
  const tab = parseTab(params.tab);

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <PageHeroIdentity
            icon={Gift}
            accent="rose"
            title="Rewards Insights"
            subtitle="Cross-reward analysis, ROI, retention impact, cohort lift, marketing cost vs revenue."
          />
          <div className="flex flex-wrap items-center gap-2">
            <InsightsRewardsPeriodFilter />
            <ExportButton page="rewards" params={{ period }} />
          </div>
        </div>
      </PageHero>

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
