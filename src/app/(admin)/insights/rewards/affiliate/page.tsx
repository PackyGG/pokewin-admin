import { Suspense } from "react";
import { Share2 } from "lucide-react";
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
import { AffiliatePeriodFilter } from "./_components/period-filter";
import { AffiliateInsightsTabSwitch } from "./_components/tab-switch";
import {
  AffiliateInsightsTabSkeleton,
  AffiliateInsightsCompactSkeleton,
} from "./_components/tab-skeleton";
import { AffiliateOverviewTab } from "./_components/overview-tab";
import { AffiliateTopWagerTab } from "./_components/top-wager-tab";
import { AffiliateCohortTab } from "./_components/cohort-tab";
import { AffiliateInactiveTab } from "./_components/inactive-tab";
import { AffiliateCodePerfTab } from "./_components/code-perf-tab";
import { AffiliateGeoTab } from "./_components/geo-tab";
import { AffiliateLifetimeRoiTab } from "./_components/lifetime-roi-tab";
import { AffiliateCadenceTab } from "./_components/cadence-tab";
import { AffiliateCodeSwitchTab } from "./_components/code-switch-tab";
import { AffiliateTierDistributionTab } from "./_components/tier-distribution-tab";
import { AffiliateForecastTab } from "./_components/forecast-tab";

export const metadata = { title: "Affiliate Insights" };

type Tab =
  | "overview"
  | "top-wager"
  | "tier-distribution"
  | "cohort"
  | "inactive"
  | "code-perf"
  | "geo"
  | "lifetime-roi"
  | "cadence"
  | "code-switch"
  | "forecast";

function parseTab(value: string | undefined): Tab {
  switch (value) {
    case "top-wager":
    case "tier-distribution":
    case "cohort":
    case "inactive":
    case "code-perf":
    case "geo":
    case "lifetime-roi":
    case "cadence":
    case "code-switch":
    case "forecast":
      return value;
    default:
      return "overview";
  }
}

/**
 * /insights/rewards/affiliate — full deep-stats page for the affiliate
 * program. Sits under the Insights/Rewards group as the affiliate-only
 * deep-dive. Reuses the same period set as /insights/rewards
 * (24h / 3d / 7d / 30d / 90d / lifetime).
 *
 * Tabs:
 *   1. Overview        — KPI strip + daily commission area chart + ROI
 *   2. Top by wager    — top 25 by referred-cohort wager (activity lens)
 *   3. Tier distrib.   — affiliate count per level (1–8), computed from
 *                        lifetime referred wager vs the config ladder
 *   4. Cohort          — per-affiliate cohort conversion + retention
 *   5. Inactive        — affiliates with referrals but no claim in window
 *   6. Code funnel     — click → signup → first deposit → wager per code
 *   7. Geo             — affiliate geo + referred-user geo
 *   8. Lifetime ROI    — per-affiliate lifetime ROI from affiliate_accounts
 *   9. Claim cadence   — per-affiliate claim repeat rhythm
 *  10. Code-switch     — cohorts that disproportionately moved to other codes
 *
 * House-POV: every dollar of commission is house cost → rose. Every
 * dollar of downstream wager is house-positive (we take the rake) →
 * emerald. ROI = wager − commission, signed.
 *
 * Read-only against Main DB. Staff (admin/support) + excluded users
 * filtered out at every helper. Each tab is its own async server
 * component wrapped in `safeQuery` so a single failed query degrades
 * its tile but doesn't crash the page.
 */
export default async function AffiliateInsightsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/insights/rewards/affiliate");
  const params = await searchParams;
  const period = parseInsightsRewardsPeriod(params.period);
  const tab = parseTab(params.tab);

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <PageHeroIdentity
            icon={Share2}
            accent="rose"
            title="Affiliate Insights"
            subtitle="Per-affiliate ROI, downstream wager attribution, referral funnel, inactive affiliates."
          />
          <div className="flex flex-wrap items-center gap-2">
            <AffiliatePeriodFilter />
            <ExportButton page="affiliate" params={{ period }} />
          </div>
        </div>
      </PageHero>

      <AffiliateInsightsTabSwitch />

      {/* Suspense keyed on (tab, period) — flipping either re-renders
          the skeleton instead of stalling on stale numbers. Each tab
          is its own async server component that fetches its own data;
          the cached query layer absorbs the round-trip cost. */}
      <Suspense
        key={`${tab}:${period}`}
        fallback={
          tab === "inactive" || tab === "cadence" || tab === "code-switch"
            ? <AffiliateInsightsCompactSkeleton />
            : <AffiliateInsightsTabSkeleton />
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
      return <AffiliateOverviewTab period={period} />;
    case "top-wager":
      return <AffiliateTopWagerTab period={period} />;
    case "tier-distribution":
      return <AffiliateTierDistributionTab />;
    case "cohort":
      return <AffiliateCohortTab period={period} />;
    case "inactive":
      return <AffiliateInactiveTab period={period} />;
    case "code-perf":
      return <AffiliateCodePerfTab period={period} />;
    case "geo":
      return <AffiliateGeoTab period={period} />;
    case "lifetime-roi":
      return <AffiliateLifetimeRoiTab />;
    case "cadence":
      return <AffiliateCadenceTab period={period} />;
    case "code-switch":
      return <AffiliateCodeSwitchTab period={period} />;
    case "forecast":
      return <AffiliateForecastTab period={period} />;
  }
}
