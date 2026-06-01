import { Suspense } from "react";
import { Coins } from "lucide-react";
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
import { exportDepositBonusData } from "./_export";
import { DepositBonusPeriodFilter } from "./_components/period-filter";
import { DepositBonusTabSwitch } from "./_components/tab-switch";
import { DepositBonusTabSkeleton } from "./_components/tab-skeleton";
import { OverviewTab } from "./_components/overview-tab";
import { CapTab } from "./_components/cap-tab";
import { CohortsTab } from "./_components/cohorts-tab";
import { RoiTab } from "./_components/roi-tab";
import { RiskTab } from "./_components/risk-tab";

export const metadata = { title: "Deposit Bonus Insights" };

type Tab = "overview" | "cap" | "cohorts" | "roi" | "risk";

function parseTab(value: string | undefined): Tab {
  switch (value) {
    case "cap":
    case "cohorts":
    case "roi":
    case "risk":
      return value;
    default:
      return "overview";
  }
}

/**
 * /insights/rewards/deposit-bonus — deepest-possible deposit-bonus
 * insight surface.
 *
 * Five super-tabs covering every metric block in the spec, mapped onto
 * a usable nav:
 *
 *   1. Overview     — KPI strip (cost / count / claimants / avg / median
 *                      / max / cap-hit / avg-per-claimant) + period
 *                      delta + daily volume chart + day-by-day
 *                      breakdown table.
 *   2. Cap & Ratio  — empirical cap value, hit rate, amount distribution
 *                      histogram (0 → cap), top 10 cap hitters, biggest
 *                      cap-paired deposits, bonus/deposit ratio
 *                      distribution + mean/median ratio.
 *   3. Cohorts      — with-bonus vs without (avg/median/p99 deposit,
 *                      retention 7d/30d, lift %), new vs returning
 *                      claimants, repeat-claimant segmentation (1 /
 *                      2-5 / 6-20 / 21+), time-to-claim latency
 *                      distribution + p50/p95/p99.
 *   4. ROI & Geo    — ROI lens (cost vs subsequent gameplay GGR in 14d
 *                      lookback), bonus efficiency (cost / wager), top
 *                      countries by bonus $, top signup sources, hour-
 *                      of-day + day-of-week distribution.
 *   5. Top & Risk   — top 25 bonus recipients (with lifetime, deposit,
 *                      wager, GGR columns) + suspicious-claimant
 *                      surveillance (cash-out abuse, no-wager, shared
 *                      fingerprint clusters).
 *
 * Period selector exposes 24h / 3d / 7d / 30d / 90d / lifetime (same
 * window set as the parent /insights/rewards page).
 *
 * Every query is `safeQuery`-wrapped so a single failure degrades only
 * its tile / section, not the whole tab.
 *
 * House-POV: bonuses are house cost → rose. ROI flips emerald when
 * subsequent GGR exceeds cost. Deposits / wagers → emerald (house
 * captures the spend). Withdrawal flags → rose. Cap-hit signals → amber.
 */
export default async function DepositBonusInsightsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/insights/rewards/deposit-bonus");
  const params = await searchParams;
  const period = parseInsightsRewardsPeriod(params.period);
  const tab = parseTab(params.tab);

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <PageHeroIdentity
            icon={Coins}
            accent="rose"
            title="Deposit Bonus Insights"
            subtitle="Cap hit rate, claim cohorts, ROI, retention — everything we know about deposit bonuses."
          />
          <div className="flex flex-wrap items-center gap-2">
            <DepositBonusPeriodFilter />
            <ExportButton
              action={exportDepositBonusData.bind(null, period)}
              filename={`insights-deposit-bonus-${period}.csv`}
            />
          </div>
        </div>
      </PageHero>

      <DepositBonusTabSwitch />

      <Suspense
        key={`${tab}:${period}`}
        fallback={<DepositBonusTabSkeleton />}
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
    case "cap":
      return <CapTab period={period} />;
    case "cohorts":
      return <CohortsTab period={period} />;
    case "roi":
      return <RoiTab period={period} />;
    case "risk":
      return <RiskTab period={period} />;
  }
}
