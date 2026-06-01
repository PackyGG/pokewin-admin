import { Suspense } from "react";
import { UserPlus } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import {
  PageHero,
  PageHeroIdentity,
} from "@/components/modern-panels";
import {
  parseInsightsRewardsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { ExportButton } from "@/components/export-button";
import { SignupInsightsPeriodFilter } from "./_components/period-filter";
import { SignupInsightsTabSwitch } from "./_components/tab-switch";
import {
  SignupInsightsTabSkeleton,
  SignupInsightsCompactTabSkeleton,
} from "./_components/tab-skeleton";
import { OverviewTab } from "./_components/overview-tab";
import { FunnelTab } from "./_components/funnel-tab";
import { TimeToClaimTab } from "./_components/time-to-claim-tab";
import { RetentionTab } from "./_components/retention-tab";
import { FirstDepositTab } from "./_components/first-deposit-tab";
import { SourceTab } from "./_components/source-tab";
import { CountryTab } from "./_components/country-tab";
import { HourTab } from "./_components/hour-tab";
import { CohortMatrixTab } from "./_components/cohort-tab";
import { DropOffTab } from "./_components/drop-off-tab";
import { TopRecipientsTab } from "./_components/top-recipients-tab";
import { GeoTrendTab } from "./_components/geo-trend-tab";

export const metadata = { title: "Signup Reward Insights" };

type Tab =
  | "overview"
  | "funnel"
  | "time-to-claim"
  | "retention"
  | "first-deposit"
  | "source"
  | "country"
  | "hour"
  | "cohort"
  | "drop-off"
  | "top"
  | "geo-trend";

function parseTab(value: string | undefined): Tab {
  switch (value) {
    case "funnel":
    case "time-to-claim":
    case "retention":
    case "first-deposit":
    case "source":
    case "country":
    case "hour":
    case "cohort":
    case "drop-off":
    case "top":
    case "geo-trend":
      return value;
    default:
      return "overview";
  }
}

/**
 * /insights/rewards/signup — deep signup-cohort analytics surface.
 *
 * Sits below /insights/rewards as the centerpiece for understanding
 * signup-cohort behaviour: signup → bonus claim → deposit → retention.
 *
 * Twelve tabs:
 *
 *   1.  Overview        — top-line KPIs + daily signup/claim chart
 *   2.  Funnel          — 5-stage conversion funnel (signup → repeat)
 *   3.  Time-to-claim   — histogram + p25/p50/p75/p95 + cumulative shares
 *   4.  Retention       — claimer vs non-claimer 24h/7d/30d retention curves
 *   5.  First deposit   — cohort first-deposit size comparison + buckets
 *   6.  Source          — auth provider + affiliate code attribution
 *   7.  Country         — top-15 countries + continent rollup
 *   8.  Hour-of-day     — 24-bin + day-of-week + 7×24 heatmap
 *   9.  Cohort matrix   — weekly signup cohort × claim × 30d retention
 *  10.  Drop-off        — 5 mutually-exclusive drop-off cause buckets
 *  11.  Top recipients  — top 25 by signup-bonus volume in window
 *  12.  Geo trend       — top-5 countries' signup → claim trend series
 *
 * Cohort definition shared across every tab: the in-window signup
 * cohort. Claims are matched against the cohort by user_id at ANY time
 * (so an in-window signup who claimed tomorrow still counts).
 *
 * Period selector exposes 24h / 3d / 7d / 30d / 90d / lifetime — same
 * grain as the parent /insights/rewards page so cross-page
 * comparisons reconcile.
 *
 * House-POV:
 *   - signups        → blue   (neutral acquisition)
 *   - claims / cost  → rose   (house cost — every dollar of signup
 *                              bonus is a dollar we owe the user)
 *   - retention lift → blue   (positive product signal, not house
 *                              profit, so we don't pure-emerald it)
 *   - deposit total  → emerald (house income from depositors)
 *
 * Source of truth across every tab: `ledger_transactions` rows with
 * `status = 'completed'` AND `type = 'balance_reward_claim'`. The
 * platform has no dedicated `signup_bonus` ledger type — all signup
 * pack claims land in the generic balance_reward_claim row, so the
 * cohort narrowing is the user.created_at window joined to the user's
 * first claim row.
 */
export default async function SignupInsightsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/insights/rewards/signup");
  const params = await searchParams;
  const period = parseInsightsRewardsPeriod(params.period);
  const tab = parseTab(params.tab);

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <PageHeroIdentity
            icon={UserPlus}
            accent="rose"
            title="Signup Reward Insights"
            subtitle="Signup → bonus claim → deposit → retention. Cohort conversion funnel, geo, source attribution."
          />
          <div className="flex flex-wrap items-center gap-2">
            <SignupInsightsPeriodFilter />
            <ExportButton page="signup" params={{ period }} />
          </div>
        </div>
      </PageHero>

      <SignupInsightsTabSwitch />

      {/* Suspense keyed on (tab, period) — flipping either re-renders
          the skeleton instead of stalling on stale numbers. Compact
          tabs (cohort matrix, top recipients) use the smaller
          skeleton because they don't lead with a multi-chart row. */}
      <Suspense
        key={`${tab}:${period}`}
        fallback={
          tab === "cohort" || tab === "top" || tab === "drop-off"
            ? <SignupInsightsCompactTabSkeleton />
            : <SignupInsightsTabSkeleton />
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
    case "funnel":
      return <FunnelTab period={period} />;
    case "time-to-claim":
      return <TimeToClaimTab period={period} />;
    case "retention":
      return <RetentionTab period={period} />;
    case "first-deposit":
      return <FirstDepositTab period={period} />;
    case "source":
      return <SourceTab period={period} />;
    case "country":
      return <CountryTab period={period} />;
    case "hour":
      return <HourTab period={period} />;
    case "cohort":
      return <CohortMatrixTab period={period} />;
    case "drop-off":
      return <DropOffTab period={period} />;
    case "top":
      return <TopRecipientsTab period={period} />;
    case "geo-trend":
      return <GeoTrendTab period={period} />;
  }
}
