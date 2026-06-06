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
import { formatCurrency, formatNumber } from "@/lib/utils/format";

import { HubQuickTools } from "./_components/hub-quick-tools";
import { NetGgrBreakdownPopover } from "../../(admin)/creators/_components/net-ggr-breakdown-popover";
import {
  DepositsChart,
  WagerChart,
} from "../../(admin)/dashboard/charts";

import { HubKpiBox } from "./_components/hub-kpi-box";
import { HubKpiInfoPopover } from "./_components/hub-kpi-info-popover";
import { HubWagerBreakdownPopover } from "./_components/hub-wager-breakdown-popover";
import { HubTopCreators } from "./_components/hub-top-creators";
import { HubPeriodSelector } from "./_components/hub-period-selector";
import { hubChartTitleSuffix } from "./_queries/hub-chart-series";
import { hubBucketByHour } from "./_queries/hub-period-sql";
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
  const periodLabel =
    windowLabel.charAt(0).toUpperCase() + windowLabel.slice(1);

  const chartSuffix = hubChartTitleSuffix(period);
  const hourlyXAxis = hubBucketByHour(period);

  const signupLeaderLines = [...data.topCreators]
    .filter((c) => c.signups > 0)
    .sort((a, b) => b.signups - a.signups)
    .slice(0, 5)
    .map((c) => ({
      label: c.username ?? "Unknown",
      value: formatNumber(c.signups),
      tone: "foreground" as const,
    }));

  const creatorCostLines =
    data.creatorCostBreakdown?.lines
      .filter((l) => l.amount > 0)
      .map((l) => ({
        label: l.label,
        value: formatCurrency(l.amount),
        tone: "rose" as const,
      })) ?? [];

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
          info={
            data.totalCreators != null ? (
              <HubKpiInfoPopover
                title="Total creators · breakdown"
                description="Live backend roster count. Sub-lines show fill-program creators and those with an active or scheduled deal."
                lines={[
                  {
                    label: "All creators",
                    value: formatNumber(data.totalCreators),
                  },
                  ...(data.creatorsStats
                    ? [
                        {
                          label: "With fill deals",
                          value: formatNumber(data.creatorsStats.fillCreatorCount),
                        },
                        {
                          label: "Active / scheduled deal",
                          value: formatNumber(data.creatorsStats.activeDealCount),
                        },
                      ]
                    : []),
                ]}
              />
            ) : undefined
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
          info={
            data.ggrLegs ? (
              <HubWagerBreakdownPopover
                packBattleWager={data.ggrLegs.packBattleWager}
                upgraderWager={data.ggrLegs.upgraderWager}
                wagersTotal={data.ggrLegs.wagersTotal}
                periodLabel={periodLabel}
              />
            ) : undefined
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
          info={
            data.creatorCostBreakdown ? (
              <HubKpiInfoPopover
                title={`Creator cost · ${periodLabel}`}
                description="House spend on creator activity in the selected window — every line is money paid out (a house cost): fill conversion vouchers minted, multiplier payouts, house-funded tips, and full leaderboard prize gross."
                lines={creatorCostLines}
                footer={{
                  label: "Total",
                  value: formatCurrency(data.creatorCostBreakdown.total),
                  tone: "rose",
                }}
                ringClassName="focus-visible:ring-rose-500/40"
              />
            ) : undefined
          }
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
          info={
            data.liveCount != null ? (
              <HubKpiInfoPopover
                title="Live now"
                description="Creators with an active fill stream session right now (`active_session_id` on the backend roster). Updates as creators go live or end a session."
                lines={[
                  {
                    label: "Streaming now",
                    value: formatNumber(data.liveCount),
                  },
                ]}
              />
            ) : undefined
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
          info={
            data.signups != null ? (
              <HubKpiInfoPopover
                title={`Sign-ups · ${periodLabel}`}
                description="New users who joined in the window and were referred by a creator (`user.referred_by` points at a creator account). Staff and excluded users are dropped."
                lines={signupLeaderLines}
                footer={{
                  label: "Total",
                  value: formatNumber(data.signups),
                }}
              />
            ) : undefined
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
          info={
            data.ftds != null ? (
              <HubKpiInfoPopover
                title={`New FTDs · ${periodLabel}`}
                description="Distinct referred players who made their first code-attributed deposit in the window (`affiliate_code_usages` with `usage_type = deposit`). Self-attributed creator play is excluded."
                footer={{
                  label: "Total FTDs",
                  value: formatNumber(data.ftds),
                }}
              />
            ) : undefined
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
          info={
            data.depositsUsd != null ? (
              <HubKpiInfoPopover
                title={`Deposits · ${periodLabel}`}
                description="Sum of completed player deposits in the window, attributed to the creator whose code covered the player at deposit time (7-day lookback, most recent code wins)."
                footer={{
                  label: "Total",
                  value: formatCurrency(data.depositsUsd),
                  tone: "emerald",
                }}
                ringClassName="focus-visible:ring-emerald-500/40"
              />
            ) : undefined
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
          info={
            data.ggrLegs && data.netGgrUsd != null ? (
              <NetGgrBreakdownPopover
                packBattleWager={data.ggrLegs.packBattleWager}
                upgraderWager={data.ggrLegs.upgraderWager}
                inventoryPayout={data.ggrLegs.inventoryPayout}
                battleRefundLedger={data.ggrLegs.battleRefundLedger}
                upgraderPayout={data.ggrLegs.upgraderPayout}
                wagersTotal={data.ggrLegs.wagersTotal}
                payoutsTotal={data.ggrLegs.payoutsTotal}
                ggr={data.netGgrUsd}
                periodLabel={periodLabel}
              />
            ) : undefined
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

        <WagerChart
          title={`Code-cohort wagers · ${chartSuffix}`}
          data={data.dailyWagers}
          hourlyXAxis={hourlyXAxis}
        />

        <DepositsChart
          title={`Code-cohort deposits · ${chartSuffix}`}
          data={data.dailyDeposits}
          hourlyXAxis={hourlyXAxis}
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
