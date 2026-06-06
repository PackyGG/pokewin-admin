import { Suspense } from "react";
import {
  Megaphone,
  Users,
  TrendingUp,
  Coins,
  Tv,
  UserPlus,
  Check,
  ArrowDownToLine,
  Trophy,
  Sparkles,
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
import { formatCurrency, formatNumber, formatCompactUsd } from "@/lib/utils/format";

import { HubQuickTools } from "./_components/hub-quick-tools";
import { HubCreatorCheckWidget } from "./_components/hub-creator-check-widget";
import { HubKpiBox } from "./_components/hub-kpi-box";
import { HubTopCreators } from "./_components/hub-top-creators";
import { HubChartCard } from "./_components/hub-chart-card";
import { HubPeriodSelector } from "./_components/hub-period-selector";
import { getHubDashboardOverview } from "./_queries/dashboard-overview";

export const metadata = { title: "Creator Hub" };

/**
 * Creator Hub — home dashboard.
 *
 * Layout (matches the approved mockup):
 *   1. Slim hero ("Creator Hub" + window label).
 *   2. Quick-tools button row (My Creators / Leaderboards / ROI Calculator
 *      / Social Posts / Changelogs — placeholder links for v1).
 *   3. Overview KPI boxes (house-POV colors).
 *   4. 3-up row: Top Creators (ranked) + Wager chart + Deposits chart.
 *
 * ACCESS: `canAccessCreatorHub` (the layout enforces it; this page adds the
 * explicit gate too — every protected page gates server-side first).
 *
 * ACTIVE-TIMEFRAME-ONLY: the period selector defaults to 24h; the data
 * section is wrapped in a Suspense boundary keyed on `period`, so only the
 * active window is fetched on first render and switching lazily loads just
 * the picked window (never preloading all windows).
 */
export default async function CreatorHubDashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireCreatorHubPageAccess();

  const period = parseDashboardPeriod((await searchParams).period);
  const windowLabel = DASHBOARD_PERIOD_LABELS[period].toLowerCase();

  return (
    <div className="space-y-6">
      {/* Slim hero — Creator Hub identity + active window. */}
      <PageHero>
        <PageHeroIdentity
          icon={Megaphone}
          accent="pink"
          title="Creator Hub"
          subtitle={`Your CM team's command center · ${windowLabel}`}
        />
      </PageHero>

      {/* Quick tools */}
      <HubQuickTools />

      <HubCreatorCheckWidget />

      {/* Overview — window selector + KPI boxes + 3-up row. The whole
          data-bearing block is keyed on `period` so only the active window
          loads and switching repaints just this boundary (lazy). */}
      <div className="space-y-3">
        <SectionHeading
          icon={TrendingUp}
          title="Overview"
          action={<HubPeriodSelector current={period} />}
        />
        <Suspense key={period} fallback={<OverviewSkeleton />}>
          <OverviewSection period={period} />
        </Suspense>
      </div>
    </div>
  );
}

// ─── Overview section (data-bearing, streamed via Suspense) ─────────

async function OverviewSection({ period }: { period: DashboardPeriod }) {
  const data = await getHubDashboardOverview(period);
  const windowLabel = DASHBOARD_PERIOD_LABELS[period].toLowerCase();

  return (
    <FadeIn className="space-y-4">
      {/* KPI boxes — house-POV colors:
            • blue   = neutral count (creators / live / signups / FTDs)
            • emerald = house gain (affiliate wager / deposits / GGR)
            • rose   = house cost (creator cost) */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <HubKpiBox
          label="Total Creators"
          icon={Users}
          accent="blue"
          value={data.totalCreators != null ? formatNumber(data.totalCreators) : "—"}
          sub="all creator accounts"
          placeholder={data.totalCreators == null}
          placeholderNote={
            data.rosterUnavailable ? "Backend unavailable" : "No data yet"
          }
        />
        <HubKpiBox
          label={`Affiliate Wager · ${period}`}
          icon={TrendingUp}
          accent="emerald"
          value={
            data.affiliateWagerUsd != null
              ? formatCurrency(data.affiliateWagerUsd)
              : "—"
          }
          sub={`code-cohort wager · ${windowLabel}`}
          placeholder={data.affiliateWagerUsd == null}
          placeholderNote={
            data.affiliateWagerUsd == null
              ? "Windowed GGR query unavailable"
              : undefined
          }
        />
        <HubKpiBox
          label={`Creator Cost · ${period}`}
          icon={Coins}
          accent="rose"
          value={
            data.creatorCostUsd != null
              ? formatCurrency(data.creatorCostUsd)
              : "—"
          }
          sub={`withdrawals + tips + LB · ${windowLabel}`}
          placeholder={data.creatorCostUsd == null}
        />
        <HubKpiBox
          label="Live Now"
          icon={Tv}
          accent="blue"
          value={data.liveCount != null ? formatNumber(data.liveCount) : "—"}
          sub="creators streaming now"
          live={data.liveCount != null && data.liveCount > 0}
          placeholder={data.liveCount == null}
          placeholderNote={
            data.rosterUnavailable ? "Backend unavailable" : "No data yet"
          }
        />
        <HubKpiBox
          label={`Sign-ups · ${period}`}
          icon={UserPlus}
          accent="blue"
          value={
            data.signups != null ? formatNumber(data.signups) : "—"
          }
          sub={`referred by creators · ${windowLabel}`}
          placeholder={data.signups == null}
          placeholderNote={
            data.cohortUnavailable ? "Cohort metrics unavailable" : undefined
          }
        />
        <HubKpiBox
          label={`New FTDs · ${period}`}
          icon={Check}
          accent="blue"
          value={data.ftds != null ? formatNumber(data.ftds) : "—"}
          sub={`code-attributed depositors · ${windowLabel}`}
          placeholder={data.ftds == null}
          placeholderNote={
            data.cohortUnavailable ? "Cohort metrics unavailable" : undefined
          }
        />
        <HubKpiBox
          label={`Deposits · ${period}`}
          icon={ArrowDownToLine}
          accent="emerald"
          value={
            data.depositsUsd != null
              ? formatCurrency(data.depositsUsd)
              : "—"
          }
          sub={`coverage-attributed · ${windowLabel}`}
          placeholder={data.depositsUsd == null}
          placeholderNote={
            data.cohortUnavailable ? "Cohort metrics unavailable" : undefined
          }
        />
        {/* Net Code-User GGR — a real bonus figure from the same windowed
            pass (house POV). Emerald when the cohort net-lost to us; we
            keep the box emerald-accented since GGR here is the house-gain
            lens, and show the signed value. */}
        <HubKpiBox
          label={`Net Cohort GGR · ${period}`}
          icon={Sparkles}
          accent="emerald"
          value={
            data.netGgrUsd != null ? formatCurrency(data.netGgrUsd) : "—"
          }
          sub={`wager − payout · ${windowLabel}`}
          placeholder={data.netGgrUsd == null}
          placeholderNote={
            data.netGgrUsd == null
              ? "Windowed GGR query unavailable"
              : undefined
          }
        />
      </div>

      {/* 3-up row: Top Creators (hero) + Wager chart + Deposits chart. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.05fr_1fr_1fr]">
        <div className="rounded-2xl border bg-card p-4 sm:p-5">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-sm font-semibold">
              <Trophy className="size-4 text-amber-500" />
              Top Creators
            </span>
            <span className="text-[11px] text-muted-foreground">
              {windowLabel}
            </span>
          </div>
          <HubTopCreators
            creators={data.topCreators}
            periodLabel={period}
          />
        </div>

        <HubChartCard
          title="Wager"
          headline={
            data.affiliateWagerUsd != null
              ? formatCompactUsd(data.affiliateWagerUsd)
              : null
          }
          series={data.wagerSeries}
          placeholderNote={
            data.cohortUnavailable
              ? "Chart unavailable — cohort query failed"
              : undefined
          }
        />

        <HubChartCard
          title="Deposits"
          headline={
            data.depositsUsd != null
              ? formatCompactUsd(data.depositsUsd)
              : null
          }
          series={data.depositSeries}
          placeholderNote={
            data.cohortUnavailable
              ? "Chart unavailable — cohort query failed"
              : undefined
          }
        />
      </div>
    </FadeIn>
  );
}

// ─── Skeleton ──────────────────────────────────────────────────────

function OverviewSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-[104px] rounded-2xl" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-[260px] rounded-2xl" />
        ))}
      </div>
    </div>
  );
}
