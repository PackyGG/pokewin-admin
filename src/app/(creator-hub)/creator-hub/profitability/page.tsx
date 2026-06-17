import { Suspense } from "react";
import { Activity, Coins, LineChart, Percent, TrendingUp } from "lucide-react";

import { requireCreatorHubPageAccess } from "@/lib/require-creator-hub-access";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/utils/format";

import { getCreatorProfitability } from "../../../(admin)/creators/_queries/deal-profitability";
import { HubKpiBox } from "../_components/hub-kpi-box";
import { ProfitabilityList } from "./_components/profitability-list";

export const metadata = { title: "Profitability · Creator Hub" };

/**
 * Creator Hub — Profitability.
 *
 * Costs out every active creator deal (withdraw cap + leaderboard funding
 * + tip pool, normalised to the deal's payout window) and checks it
 * against the wager the creator actually drove in that window. Shell-first:
 * the hero paints instantly; the costed roster streams behind Suspense.
 *
 * ACCESS: `requireCreatorHubPageAccess` — same gate as the rest of the Hub.
 */
export default async function CreatorHubProfitabilityPage() {
  await requireCreatorHubPageAccess();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={TrendingUp}
          accent="emerald"
          title="Profitability"
          subtitle="Per-creator deal cost vs expected & actual wager — conversion check."
        />
      </PageHero>

      <Suspense fallback={<ProfitabilitySkeleton />}>
        <ProfitabilitySection />
      </Suspense>
    </div>
  );
}

async function ProfitabilitySection() {
  const { rows, totals } = await getCreatorProfitability();

  // House-POV: a positive house P&L is a house gain (emerald); negative
  // is a house loss (rose).
  const pnlAccent = totals.totalActualPnl >= 0 ? "emerald" : "rose";

  return (
    <FadeIn className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <HubKpiBox
          label="Total Cost"
          icon={Coins}
          accent="rose"
          value={formatCurrency(totals.totalCost)}
          sub="Deal cost + sponsorships"
        />
        <HubKpiBox
          label="Total Actual PNL"
          icon={LineChart}
          accent={pnlAccent}
          value={formatCurrency(totals.totalActualPnl)}
          sub="GGR (7.5%) − deal cost"
        />
        <HubKpiBox
          label="Expected Wager"
          icon={TrendingUp}
          accent="blue"
          value={formatCurrency(totals.totalExpectedWagerMonthly)}
          sub="Monthly · to cover cost"
        />
        <HubKpiBox
          label="Creator Wager"
          icon={Activity}
          accent="emerald"
          value={formatCurrency(totals.totalCreatorWager)}
          sub="Actual · in deal windows"
        />
        <HubKpiBox
          label="Avg Conversion"
          icon={Percent}
          accent="blue"
          value={`${totals.avgConversionRate.toFixed(2)}x`}
          sub="Actual ÷ expected wager"
        />
      </div>

      <div className="space-y-3">
        <SectionHeading icon={Coins} title={`Active deals (${rows.length})`} />
        <ProfitabilityList rows={rows} />
      </div>
    </FadeIn>
  );
}

function ProfitabilitySkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-[104px] rounded-2xl" />
        ))}
      </div>
      <div className="space-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-[76px] rounded-2xl" />
        ))}
      </div>
    </div>
  );
}
