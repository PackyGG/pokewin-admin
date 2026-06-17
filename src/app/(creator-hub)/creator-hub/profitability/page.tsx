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

import { getCreatorProfitability } from "./_queries/deal-profitability";
import { HubKpiBox } from "../_components/hub-kpi-box";
import { ProfitabilityList } from "./_components/profitability-list";
import { RosterError } from "../creators/_components/roster-error";

export const metadata = { title: "Profitability · Creator Hub" };

/**
 * Creator Hub — Profitability.
 *
 * Costs out every creator with a current deal over the frame of their
 * active leaderboard cycle, and checks it against the wager driven INSIDE
 * that frame. Shell-first: the hero paints instantly; the costed roster
 * streams behind Suspense.
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
          subtitle="Per-creator deal cost vs the wager driven in the current deal frame."
        />
      </PageHero>

      <div className="space-y-3">
        <SectionHeading icon={Coins} title="Deal economics" />
        <Suspense fallback={<ProfitabilitySkeleton />}>
          <ProfitabilitySection />
        </Suspense>
      </div>
    </div>
  );
}

async function ProfitabilitySection() {
  const { rows, totals, rosterUnavailable } = await getCreatorProfitability();

  if (rosterUnavailable) {
    return <RosterError />;
  }

  // House-POV: positive house P&L is a house gain (emerald); negative a loss.
  const pnlAccent = totals.totalActualPnl >= 0 ? "emerald" : "rose";

  return (
    <FadeIn className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <HubKpiBox
          label="Total Cost"
          icon={Coins}
          accent="rose"
          value={formatCurrency(totals.totalCost)}
          sub="Cap + leaderboard + tips"
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
          value={formatCurrency(totals.totalExpectedWager)}
          sub="To cover deal cost"
        />
        <HubKpiBox
          label="Creator Wager"
          icon={Activity}
          accent="emerald"
          value={formatCurrency(totals.totalCreatorWager)}
          sub="Actual · in deal frame"
        />
        <HubKpiBox
          label="Avg Conversion"
          icon={Percent}
          accent="blue"
          value={`${totals.avgConversionRate.toFixed(2)}x`}
          sub="Actual ÷ expected wager"
        />
      </div>

      <div className="space-y-2">
        <p className="text-[11px] text-muted-foreground">
          Each creator&apos;s deal cost is checked against the wager driven
          inside their current leaderboard cycle (the active deal frame).
        </p>
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
