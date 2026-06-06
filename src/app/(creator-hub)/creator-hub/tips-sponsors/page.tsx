import { Suspense } from "react";
import {
  Gift,
  HeartHandshake,
  Layers,
  ListOrdered,
  Receipt,
  Tv,
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
import {
  parseDashboardPeriod,
  DASHBOARD_PERIOD_LABELS,
  type DashboardPeriod,
} from "@/lib/queries/dashboard-period";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

import { HubKpiBox } from "../_components/hub-kpi-box";
import { HubKpiInfoPopover } from "../_components/hub-kpi-info-popover";
import { HubPeriodSelector } from "../_components/hub-period-selector";
import { getTipsSponsorsOverview } from "./_queries/tips-sponsors-data";
import { TipsSponsorsChart } from "./_components/tips-sponsors-chart";
import { CreatorSpendRanklist } from "./_components/creator-spend-ranklist";

export const metadata = { title: "Tips & Sponsors · Creator Hub" };

/**
 * Creator Hub — Tips & Sponsors.
 *
 * House-funded tips + battle sponsorships creators hand out from the fill
 * program pool. Surfaces windowed + lifetime totals, ledger txn counts,
 * session-derived per-creator breakdown, and a 30-day daily trend.
 */
export default async function CreatorHubTipsSponsorsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireCreatorHubPageAccess();

  const period = parseDashboardPeriod((await searchParams).period);
  const windowLabel = DASHBOARD_PERIOD_LABELS[period].toLowerCase();

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <PageHeroIdentity
            icon={Gift}
            accent="rose"
            title="Tips & Sponsors"
            subtitle={`House-funded creator giveaways · ${windowLabel}`}
          />
          <HubPeriodSelector current={period} />
        </div>
      </PageHero>

      <Suspense key={period} fallback={<TipsSponsorsSkeleton />}>
        <TipsSponsorsSection period={period} />
      </Suspense>
    </div>
  );
}

async function TipsSponsorsSection({ period }: { period: DashboardPeriod }) {
  const data = await getTipsSponsorsOverview(period);
  const { sessionsWindow, ledgerWindow, lifetime } = data;

  return (
    <FadeIn className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <HubKpiBox
          label="Session spend"
          icon={Gift}
          accent="rose"
          value={formatCurrency(sessionsWindow.totalUsd)}
          sub="tips + sponsors (sessions)"
          info={
            <HubKpiInfoPopover
              title="Session spend"
              description="Authoritative total from backend session counters — sums tips_spent_this_session_usd + sponsorship_spent_this_session_usd across all creators in the selected window."
            />
          }
        />
        <HubKpiBox
          label="Tips"
          icon={HeartHandshake}
          accent="rose"
          value={formatCurrency(sessionsWindow.tipsUsd)}
          sub="creator_fill_spend_tip"
        />
        <HubKpiBox
          label="Sponsors"
          icon={Layers}
          accent="rose"
          value={formatCurrency(sessionsWindow.sponsorUsd)}
          sub="creator_fill_spend_battle"
        />
        <HubKpiBox
          label="Sessions w/ spend"
          icon={Tv}
          accent="blue"
          value={formatNumber(sessionsWindow.sessionsWithSpend)}
          sub={
            sessionsWindow.activeSessionsWithSpend > 0
              ? `${formatNumber(sessionsWindow.activeSessionsWithSpend)} live now`
              : "with tips or sponsors"
          }
        />
        <HubKpiBox
          label="Creators w/ spend"
          icon={Users}
          accent="blue"
          value={formatNumber(sessionsWindow.creatorsWithSpend)}
          sub="in this window"
        />
        <HubKpiBox
          label="Lifetime total"
          icon={Receipt}
          accent="rose"
          value={formatCurrency(lifetime.totalUsd)}
          sub={`${formatCurrency(lifetime.tipsUsd)} tips · ${formatCurrency(lifetime.sponsorUsd)} sponsors`}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <HubKpiBox
          label="Ledger window"
          icon={Receipt}
          accent="rose"
          value={formatCurrency(ledgerWindow.totalUsd)}
          sub={`${formatNumber(ledgerWindow.tipTxnCount + ledgerWindow.sponsorTxnCount)} txns`}
          info={
            <HubKpiInfoPopover
              title="Ledger window"
              description="Σ |amount| over creator_fill_spend_tip + creator_fill_spend_battle in the selected window. May read $0 when ledger enum rows are not populated yet — session spend is authoritative."
            />
          }
        />
        <HubKpiBox
          label="Ledger tips"
          icon={HeartHandshake}
          accent="rose"
          value={formatCurrency(ledgerWindow.tipsUsd)}
          sub={`${formatNumber(ledgerWindow.tipTxnCount)} txns`}
        />
        <HubKpiBox
          label="Ledger sponsors"
          icon={Layers}
          accent="rose"
          value={formatCurrency(ledgerWindow.sponsorUsd)}
          sub={`${formatNumber(ledgerWindow.sponsorTxnCount)} txns`}
        />
      </div>

      <TipsSponsorsChart data={data.chart30d} />

      <div className="space-y-3">
        <SectionHeading
          icon={ListOrdered}
          title="By creator — session spend in window"
        />
        <CreatorSpendRanklist
          rows={data.byCreator}
          backendUnavailable={data.backendUnavailable}
        />
      </div>
    </FadeIn>
  );
}

function TipsSponsorsSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-[88px] rounded-2xl" />
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-[88px] rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-[340px] rounded-2xl" />
      <div className="space-y-2.5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-[72px] rounded-xl" />
        ))}
      </div>
    </div>
  );
}
