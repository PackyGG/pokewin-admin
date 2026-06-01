import { Suspense } from "react";
import { Percent } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import {
  parseInsightsRewardsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import {
  parseRakebackRoiLookback,
  type RakebackRoiLookback,
} from "@/lib/queries/insights-rewards/rakeback/roi";
import {
  parseRakebackTopClaimerScope,
  type RakebackTopClaimerScope,
} from "@/lib/queries/insights-rewards/rakeback/top-claimers";
import { RakebackPeriodFilter } from "./_components/period-filter";
import { RakebackTabSwitch } from "./_components/tab-switch";
import { RakebackTabSkeleton } from "./_components/tab-skeleton";
import { OverviewTab } from "./_components/overview-tab";
import { RateTab } from "./_components/rate-tab";
import { CadenceTab } from "./_components/cadence-tab";
import { ActiveTab } from "./_components/active-tab";
import { TiersTab } from "./_components/tiers-tab";
import { LapsedTab } from "./_components/lapsed-tab";
import { RoiTab } from "./_components/roi-tab";
import { TopClaimersTab } from "./_components/top-claimers-tab";
import { DailyTab } from "./_components/daily-tab";
import { GeoTab } from "./_components/geo-tab";

export const metadata = { title: "Rakeback Insights" };

type Tab =
  | "overview"
  | "rate"
  | "cadence"
  | "active"
  | "tiers"
  | "lapsed"
  | "roi"
  | "top"
  | "daily"
  | "geo";

function parseTab(value: string | undefined): Tab {
  switch (value) {
    case "rate":
    case "cadence":
    case "active":
    case "tiers":
    case "lapsed":
    case "roi":
    case "top":
    case "daily":
    case "geo":
      return value;
    default:
      return "overview";
  }
}

/**
 * /insights/rewards/rakeback — deep stats page for the rakeback program.
 *
 * Sits under the Insights → Rakeback nav entry (sibling pages for the
 * other reward categories live under /insights/rewards/{type}).
 *
 * Tabs:
 *   1. Overview        — top KPI strip + daily volume + period delta
 *   2. % of wager      — distribution histogram + avg / median / p95
 *   3. Cadence         — time-between-claims distribution + medians
 *   4. Active subs     — distinct claimants, weekly active, cohort retention
 *   5. Tier spread     — daily / weekly / monthly slice (reuses
 *                        getRakebackExtras.rakebackTypeSpread)
 *   6. Lapsed          — prior-window claimants who stopped + reason class
 *   7. ROI             — rakeback cost vs subsequent gameplay GGR (lookback)
 *   8. Top claimers    — top 25 by period or lifetime
 *   9. Daily breakdown — per-day table (count, volume, avg, distinct)
 *  10. Geo / Source    — country + signup-source breakdown
 *
 * Period selector exposes 24h / 3d / 7d / 30d / 90d / lifetime — wider
 * than /rewards/analytics so admins can sanity-check short spikes
 * against longer trends without leaving the page.
 *
 * House-POV everywhere: rakeback is house cost → rose. ROI flips emerald
 * when subsequent GGR recoups the spend.
 */
export default async function InsightsRakebackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/insights/rewards/rakeback");
  const params = await searchParams;
  const period = parseInsightsRewardsPeriod(params.period);
  const tab = parseTab(params.tab);
  const lookback = parseRakebackRoiLookback(params.lookback);
  const scope = parseRakebackTopClaimerScope(params.scope);

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <PageHeroIdentity
            icon={Percent}
            accent="rose"
            title="Rakeback Insights"
            subtitle="Cohort claim cadence, % of wager returned, lapsed claimants, ROI on the rakeback program."
          />
          <RakebackPeriodFilter />
        </div>
      </PageHero>

      <RakebackTabSwitch />

      {/* Suspense keyed on (tab, period, lookback, scope) — flipping any
          re-renders the skeleton instead of stalling on stale numbers. */}
      <Suspense
        key={`${tab}:${period}:${lookback}:${scope}`}
        fallback={<RakebackTabSkeleton />}
      >
        <TabContent
          tab={tab}
          period={period}
          lookback={lookback}
          scope={scope}
        />
      </Suspense>
    </div>
  );
}

async function TabContent({
  tab,
  period,
  lookback,
  scope,
}: {
  tab: Tab;
  period: InsightsRewardsPeriod;
  lookback: RakebackRoiLookback;
  scope: RakebackTopClaimerScope;
}) {
  switch (tab) {
    case "overview":
      return <OverviewTab period={period} />;
    case "rate":
      return <RateTab period={period} />;
    case "cadence":
      return <CadenceTab period={period} />;
    case "active":
      return <ActiveTab period={period} />;
    case "tiers":
      return <TiersTab period={period} />;
    case "lapsed":
      return <LapsedTab period={period} />;
    case "roi":
      return <RoiTab period={period} lookback={lookback} />;
    case "top":
      return <TopClaimersTab period={period} scope={scope} />;
    case "daily":
      return <DailyTab period={period} />;
    case "geo":
      return <GeoTab period={period} />;
  }
}
