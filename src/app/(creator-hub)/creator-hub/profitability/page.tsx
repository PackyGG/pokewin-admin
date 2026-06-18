import { Suspense } from "react";
import {
  Activity,
  Coins,
  Handshake,
  LineChart,
  Percent,
  TrendingUp,
  Users,
} from "lucide-react";

import { requireCreatorHubPageAccess } from "@/lib/require-creator-hub-access";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

import { getCreatorProfitability } from "./_queries/deal-profitability";
import { HubKpiBox } from "../_components/hub-kpi-box";
import { HubKpiInfoPopover } from "../_components/hub-kpi-info-popover";
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

  // Actual PnL = affiliates made us − deal cost (house-profit convention).
  // Positive (cohort earned back more than the deal cost → house gain) →
  // emerald; negative (deal cost exceeded earnings → house loss) → rose.
  const pnlAccent = totals.totalActualPnl < 0 ? "rose" : "emerald";
  // Affiliates made us = cohort deposits − card withdrawals (house POV).
  // Positive = we kept value (house gain) → emerald; negative → rose.
  const affiliatesAccent =
    totals.totalAffiliatesMadeUs < 0 ? "rose" : "emerald";

  return (
    <FadeIn className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
        <HubKpiBox
          label="Active Deals"
          icon={Handshake}
          accent="blue"
          value={formatNumber(totals.totalActiveDeals)}
          sub="Creators on an active deal"
        />
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
          sub="Affiliates made us − deal cost"
        />
        <HubKpiBox
          label="Affiliates Made Us"
          icon={Users}
          accent={affiliatesAccent}
          value={formatCurrency(totals.totalAffiliatesMadeUs)}
          sub="Deposits − withdrawals − claims"
          info={
            <HubKpiInfoPopover
              title="Affiliates Made Us"
              description="What each creator's affiliate cohort net-earned the house, summed across the roster. Per creator = coverage-attributed cohort deposits − card withdrawals − the creator's own affiliate_claim code earnings, all measured strictly inside that creator's deal frame. Staff, creator-role users, blacklisted users and the creator's own deposits are excluded. House POV: positive = we kept value (emerald), negative = net loss (rose)."
              footer={{
                label: "Total",
                value: formatCurrency(totals.totalAffiliatesMadeUs),
                tone: totals.totalAffiliatesMadeUs < 0 ? "rose" : "emerald",
              }}
            />
          }
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
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
        {Array.from({ length: 7 }).map((_, i) => (
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
