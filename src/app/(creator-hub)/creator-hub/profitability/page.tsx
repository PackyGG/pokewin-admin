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
import { DASHBOARD_PERIOD_LABELS } from "@/lib/queries/dashboard-period";

import { resolveRosterPeriod } from "../creators/_lib/roster-params";
import { RosterPeriodControl } from "../creators/_components/roster-period-control";
import { getCreatorProfitability } from "./_queries/deal-profitability";
import { HubKpiBox } from "../_components/hub-kpi-box";
import { ProfitabilityList } from "./_components/profitability-list";
import { RosterError } from "../creators/_components/roster-error";

export const metadata = { title: "Profitability · Creator Hub" };

/**
 * Creator Hub — Profitability.
 *
 * Costs out the fill-creator roster (the same backend-API roster the
 * /creators page walks) and checks each deal cost against the wager the
 * creator actually drove in the selected window. Shell-first: the hero +
 * window chips paint instantly; the costed roster streams behind Suspense
 * (active-timeframe-only, keyed on the window).
 */
export default async function CreatorHubProfitabilityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireCreatorHubPageAccess();

  const period = resolveRosterPeriod((await searchParams).period);
  const windowLabel = DASHBOARD_PERIOD_LABELS[period];

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

      <div className="space-y-3">
        <SectionHeading
          icon={Coins}
          title="Deal economics"
          action={<RosterPeriodControl current={period} />}
        />
        <Suspense key={period} fallback={<ProfitabilitySkeleton />}>
          <ProfitabilitySection period={period} windowLabel={windowLabel} />
        </Suspense>
      </div>
    </div>
  );
}

async function ProfitabilitySection({
  period,
  windowLabel,
}: {
  period: ReturnType<typeof resolveRosterPeriod>;
  windowLabel: string;
}) {
  const { rows, totals, rosterUnavailable } =
    await getCreatorProfitability(period);

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
          sub={`Actual · ${windowLabel}`}
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
          Deal cost is lifetime/per-deal (cap + leaderboard × house share +
          tip & sponsorship allowance). Actual wager is the creator&apos;s
          cohort wager scoped to {windowLabel}.
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
