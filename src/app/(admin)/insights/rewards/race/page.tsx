import { Suspense } from "react";
import { Flag } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import {
  PageHero,
  PageHeroIdentity,
} from "@/components/modern-panels";
import {
  parseInsightsRewardsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { RaceInsightsPeriodFilter } from "./_components/period-filter";
import { RaceInsightsTabSwitch } from "./_components/tab-switch";
import {
  RaceInsightsTabSkeleton,
  RaceInsightsTabTableSkeleton,
} from "./_components/tab-skeleton";
import { RaceOverviewTab } from "./_components/overview-tab";
import { RaceBreakdownTab } from "./_components/breakdown-tab";
import { RacePerTypeTab } from "./_components/per-type-tab";
import { RacePositionsTab } from "./_components/positions-tab";
import { RaceRepeatWinnersTab } from "./_components/repeat-tab";
import { RaceCohortTab } from "./_components/cohort-tab";
import { RaceTopWinnersTab } from "./_components/top-winners-tab";
import { RaceBudgetTab } from "./_components/budget-tab";
import { RaceRoiTab } from "./_components/roi-tab";

export const metadata = { title: "Race Insights" };

type Tab =
  | "overview"
  | "breakdown"
  | "per-type"
  | "positions"
  | "repeat"
  | "cohort"
  | "top"
  | "budget"
  | "roi";

function parseTab(value: string | undefined): Tab {
  switch (value) {
    case "breakdown":
    case "per-type":
    case "positions":
    case "repeat":
    case "cohort":
    case "top":
    case "budget":
    case "roi":
      return value;
    default:
      return "overview";
  }
}

/**
 * /insights/rewards/race — full deep stats page for Wager Races.
 *
 * Sits alongside the other Insights → Rewards sub-pages (deposit-bonus,
 * rakeback, affiliate, signup). The page is its own permission key
 * (`/insights/rewards/race`) so role grants can be tuned independently
 * from the cross-category /insights/rewards rollup.
 *
 * Tabs:
 *
 *   1. Overview        — KPI strip + daily prize chart
 *   2. Race-by-race    — list of every race instance with top winner
 *                        + tier utilisation
 *   3. Per type        — daily / weekly / monthly KPI + conversion +
 *                        budget
 *   4. Positions       — winner-position distribution
 *   5. Repeat winners  — frequency buckets + top 10 cumulative
 *   6. Cohort & Geo    — countries / sources / signup recency
 *   7. Top winners     — top 25 period + lifetime
 *   8. Budget          — blended utilisation + per-type cards
 *   9. ROI             — cost vs subsequent gameplay GGR
 *
 * Period selector exposes the same 24h / 3d / 7d / 30d / 90d / lifetime
 * grain as the parent /insights/rewards page. Tab + period live in the
 * URL so the view is shareable + ⌘-click works.
 *
 * House-POV: race prizes flow OUT to users → rose throughout. ROI flips
 * emerald when subsequent gameplay GGR exceeds the prize spend.
 */
export default async function RaceInsightsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/insights/rewards/race");
  const params = await searchParams;
  const period = parseInsightsRewardsPeriod(params.period);
  const tab = parseTab(params.tab);

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <PageHeroIdentity
            icon={Flag}
            accent="rose"
            title="Race Insights"
            subtitle="Prize distribution, winner cohorts, budget usage, top contenders"
          />
          <RaceInsightsPeriodFilter />
        </div>
      </PageHero>

      <RaceInsightsTabSwitch />

      {/* Per-tab Suspense — keyed on (tab, period) so flipping either
          re-renders the skeleton instead of stalling on stale numbers.
          The cached query layer absorbs the round-trip cost. */}
      <Suspense
        key={`${tab}:${period}`}
        fallback={
          tab === "breakdown" || tab === "top" || tab === "repeat"
            ? <RaceInsightsTabTableSkeleton />
            : <RaceInsightsTabSkeleton />
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
      return <RaceOverviewTab period={period} />;
    case "breakdown":
      return <RaceBreakdownTab period={period} />;
    case "per-type":
      return <RacePerTypeTab period={period} />;
    case "positions":
      return <RacePositionsTab period={period} />;
    case "repeat":
      return <RaceRepeatWinnersTab period={period} />;
    case "cohort":
      return <RaceCohortTab period={period} />;
    case "top":
      return <RaceTopWinnersTab period={period} />;
    case "budget":
      return <RaceBudgetTab period={period} />;
    case "roi":
      return <RaceRoiTab period={period} />;
  }
}
