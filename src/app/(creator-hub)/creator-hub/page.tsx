import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import {
  TrendingUp,
  Trophy,
  CalendarRange,
  Handshake,
  Activity,
  Percent,
  ChevronRight,
  AlertTriangle,
} from "lucide-react";

import { requireCreatorHubPageAccess } from "@/lib/require-creator-hub-access";
import { KpiTile, SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import {
  parseDashboardPeriod,
  type DashboardPeriod,
} from "@/lib/queries/dashboard-period";
import { safeQueryOrNull } from "@/lib/errors/safe-query";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import { AddCreatorDialogV2 } from "./creators/_components/add-creator-dialog-v2";
import { NetGgrBreakdownPopover } from "../../(admin)/creators/_components/net-ggr-breakdown-popover";
import { DepositsChart, WagerChart } from "../../(admin)/dashboard/charts";

import { HubKpiInfoPopover } from "./_components/hub-kpi-info-popover";
import { HubNotice } from "./_components/hub-notice";
import { SectionErrorBoundary } from "./_components/section-error-boundary";
import { HubTopCreators } from "./_components/hub-top-creators";
import { HubTopCreatorsPeriodSelector } from "./_components/hub-top-creators-period-selector";
import { HubSignupsFtdsChart } from "./_components/hub-signups-ftds-chart";
import {
  HubCreatorCostChart,
  type CreatorCostChartPoint,
} from "./_components/hub-creator-cost-chart";
import {
  HubPeriodSelector,
  hubWindowLabel,
} from "./_components/hub-period-selector";
import {
  CostChartSkeleton,
  FourWeekBandSkeleton,
  OVERVIEW_KPI_GRID_CLASS,
  OVERVIEW_KPI_TILES,
  OverviewBandSkeleton,
  TopCreatorsListSkeleton,
  TrendsBandSkeleton,
} from "./_components/hub-dashboard-skeleton";
import { getHubDashboardOverview } from "./_queries/dashboard-overview";
import { getFourWeekDealSummary } from "./_queries/four-week-summary";
import { getHubTopCreatorsByDeposits } from "./_queries/hub-top-creators-query";
import { getTopSignupLeaders } from "./_queries/hub-top-creator-meta";
import { getHubCohortCharts } from "./_queries/hub-dashboard-cohort";
import {
  getHubCreatorCostSeries,
  padCreatorCostSeries,
} from "./_queries/hub-creator-cost-series";
import {
  parseTopCreatorsPeriod,
  type TopCreatorsPeriod,
} from "./_lib/top-creators-period";

export const metadata = { title: "Creator Hub" };

/**
 * The "Deal performance" band's board walk + per-owner deal-history fan-out
 * can be a slow cold scan; 120s matches the profitability page (which does
 * the same walk). The band streams behind its own unkeyed Suspense + error
 * boundary OUTSIDE the period-keyed Overview boundary (so a chip flip hits
 * its 5-min cache instead of re-walking), and its own per-leg timeouts
 * (25s + 20s) degrade well before this — this only bounds the streamed
 * segment on a cold cache; the shell still paints instantly.
 */
export const maxDuration = 120;

/**
 * Creator Hub — home dashboard, structured by TIME CONTRACT into three
 * labelled bands so each figure's window is unambiguous:
 *
 *   a. "Overview · {window}"        — the six period-scoped KPI tiles + the
 *      creator-cost-over-time chart. ONLY this band lives inside
 *      `<Suspense key={period}>` (active-timeframe-only: a chip flip
 *      re-fetches just this band).
 *   b. "Trends · fixed 30 days"     — Wager / Deposits / Sign-ups & FTDs
 *      charts. Always 30 daily buckets (HUB_CHART_PERIOD), so the band sits
 *      OUTSIDE the period-keyed boundary in its own unkeyed Suspense and
 *      reads the cached fixed-30d cohort entry — a chip flip never re-runs
 *      the chart scans.
 *   c. "Deal performance · last 4 weeks" — the fixed 28-day deal tiles.
 *      Also OUTSIDE the period boundary (cached 5 min), so the chip flip
 *      never re-triggers the slow backend board walk.
 *
 * Between b and c: the Top Creators card with its OWN independent ranking
 * window (`?topPeriod=`), rendered as an inline "Ranking window" control so
 * it can't be confused with the global chips.
 *
 * ACCESS: `canAccessCreatorHub` (the layout enforces it; this page adds the
 * explicit gate too — every protected page gates server-side first).
 */
export default async function CreatorHubDashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireCreatorHubPageAccess();

  const params = await searchParams;
  const period = parseDashboardPeriod(params.period);
  const topPeriod = parseTopCreatorsPeriod(params.topPeriod);
  const windowLabel = hubWindowLabel(period);

  return (
    <div className="space-y-6">
      {/* a) Overview — the ONLY period-keyed band (active-timeframe-only).
          The global window chips + Add Creator live on this heading (the
          page-level "Creator Hub" title + status byline were removed by
          owner decision). */}
      <section className="space-y-3">
        <SectionHeading
          icon={TrendingUp}
          title={`Overview · ${windowLabel}`}
          action={
            <>
              <HubPeriodSelector current={period} />
              <AddCreatorDialogV2 />
            </>
          }
        />
        <SectionErrorBoundary
          fallback={<BandUnavailable label="Overview" />}
        >
          <Suspense key={period} fallback={<OverviewBandSkeleton />}>
            <OverviewSection period={period} />
          </Suspense>
        </SectionErrorBoundary>
      </section>

      {/* b) Trends — fixed 30-day charts, outside the period boundary. */}
      <section className="space-y-3">
        <SectionHeading icon={Activity} title="Trends · fixed 30 days" />
        <SectionErrorBoundary fallback={<BandUnavailable label="Trends" />}>
          <Suspense fallback={<TrendsBandSkeleton />}>
            <TrendsSection />
          </Suspense>
        </SectionErrorBoundary>
      </section>

      {/* Top Creators — own independent ranking window (?topPeriod=). The
          Card shell + control render statically; only the list streams. */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Trophy className="size-4 text-amber-500" />
              Top Creators
            </CardTitle>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Ranking window
              </span>
              <HubTopCreatorsPeriodSelector current={topPeriod} />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <SectionErrorBoundary
            fallback={<BandUnavailable label="Top creators" />}
          >
            <Suspense key={topPeriod} fallback={<TopCreatorsListSkeleton />}>
              <TopCreatorsList period={topPeriod} />
            </Suspense>
          </SectionErrorBoundary>
        </CardContent>
      </Card>

      {/* c) Deal performance — fixed 28-day view, outside the period
          boundary so a chip flip never re-runs the slow board walk. */}
      <section className="space-y-3">
        <SectionHeading
          icon={CalendarRange}
          title="Deal performance · last 4 weeks"
          action={
            <Link
              href="/creator-hub/profitability"
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              View profitability
              <ChevronRight className="size-3.5" aria-hidden />
            </Link>
          }
        />
        <SectionErrorBoundary fallback={<FourWeekUnavailable />}>
          <Suspense fallback={<FourWeekBandSkeleton />}>
            <FourWeekSection />
          </Suspense>
        </SectionErrorBoundary>
      </section>
    </div>
  );
}

// ─── Band fallbacks ────────────────────────────────────────────────

function BandUnavailable({ label }: { label: string }) {
  return (
    <HubNotice tone="amber" icon={AlertTriangle} title={`${label} unavailable`}>
      This section could not load right now — try again shortly.
    </HubNotice>
  );
}

function FourWeekUnavailable() {
  return (
    <HubNotice
      tone="amber"
      icon={AlertTriangle}
      title="4-week deal summary unavailable"
    >
      The deal-performance walk could not load right now — try again shortly.
    </HubNotice>
  );
}

// ─── a) Overview band (period-scoped, streamed via keyed Suspense) ─

async function OverviewSection({ period }: { period: DashboardPeriod }) {
  const [data, signupLeaders] = await Promise.all([
    getHubDashboardOverview(period),
    getTopSignupLeaders(period).catch((err) => {
      console.error("[creator-hub] signup leaders failed:", err);
      return [];
    }),
  ]);
  const windowLabel = hubWindowLabel(period);
  const periodLabel =
    windowLabel.charAt(0).toUpperCase() + windowLabel.slice(1);

  const signupLeaderLines = signupLeaders.map((c) => ({
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

  const wagerLines = data.ggrLegs
    ? [
        {
          label: "Packs & battles wager",
          total: data.ggrLegs.packBattleWager,
        },
        { label: "Upgrader wager", total: data.ggrLegs.upgraderWager },
      ]
        .filter((r) => r.total > 0)
        .map((r) => ({
          label: r.label,
          value: formatCurrency(r.total),
          tone: "foreground" as const,
        }))
    : [];

  // Per-tile dynamic slice (value / sub / popover) keyed by the static tile
  // definition in OVERVIEW_KPI_TILES — one map renders the whole strip, and
  // the skeleton derives its count from the same array.
  const tileData: Record<
    (typeof OVERVIEW_KPI_TILES)[number]["key"],
    {
      value: string;
      sub: string;
      accent?: "emerald" | "rose" | "blue";
      action?: ReactNode;
    }
  > = {
    wager: {
      value:
        data.affiliateWagerUsd != null
          ? formatCurrency(data.affiliateWagerUsd)
          : "—",
      sub:
        data.affiliateWagerUsd != null
          ? "code-cohort wager"
          : "Windowed GGR query unavailable",
      action: data.ggrLegs ? (
        <HubKpiInfoPopover
          title="Affiliate wager breakdown"
          description={`${periodLabel}. Code-cohort wager attributed while a creator's code covered the player (7-day windows). Real customers only — staff, excluded users, and creator-on-stream play removed.`}
          lines={wagerLines}
          footer={{
            label: "Wagers",
            value: `+${formatCurrency(data.ggrLegs.wagersTotal)}`,
            tone: "emerald",
          }}
          ringClassName="focus-visible:ring-emerald-500/40"
        />
      ) : undefined,
    },
    creatorCost: {
      value:
        data.creatorCostUsd != null
          ? formatCurrency(data.creatorCostUsd)
          : "—",
      sub:
        data.creatorCostUsd != null
          ? "withdrawals + tips + LB"
          : "Cost query unavailable",
      action: data.creatorCostBreakdown ? (
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
      ) : undefined,
    },
    signups: {
      value: data.signups != null ? formatNumber(data.signups) : "—",
      sub:
        data.signups != null
          ? "referred by creators"
          : data.cohortUnavailable
            ? "Cohort metrics unavailable"
            : "No data yet",
      action:
        data.signups != null ? (
          <HubKpiInfoPopover
            title={`Sign-ups · ${periodLabel}`}
            description="New users who joined in the window and were referred by a creator (`user.referred_by` points at a creator account). Staff and excluded users are dropped."
            lines={signupLeaderLines}
            footer={{ label: "Total", value: formatNumber(data.signups) }}
          />
        ) : undefined,
    },
    ftds: {
      value: data.ftds != null ? formatNumber(data.ftds) : "—",
      sub:
        data.ftds != null
          ? "code-attributed depositors"
          : data.cohortUnavailable
            ? "Cohort metrics unavailable"
            : "No data yet",
      action:
        data.ftds != null ? (
          <HubKpiInfoPopover
            title={`New FTDs · ${periodLabel}`}
            description="Distinct referred players who made their first code-attributed deposit in the window (`affiliate_code_usages` with `usage_type = deposit`). Self-attributed creator play is excluded."
            footer={{ label: "Total FTDs", value: formatNumber(data.ftds) }}
          />
        ) : undefined,
    },
    deposits: {
      value:
        data.depositsUsd != null ? formatCurrency(data.depositsUsd) : "—",
      sub:
        data.depositsUsd != null
          ? "coverage-attributed"
          : data.cohortUnavailable
            ? "Cohort metrics unavailable"
            : "No data yet",
      action:
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
        ) : undefined,
    },
    netGgr: {
      value: data.netGgrUsd != null ? formatCurrency(data.netGgrUsd) : "—",
      sub:
        data.netGgrUsd != null
          ? "wager − payout"
          : "Windowed GGR query unavailable",
      // House-POV: cohort net-lost to us = emerald; cohort up on us = rose.
      accent:
        data.netGgrUsd != null && data.netGgrUsd < 0 ? "rose" : "emerald",
      action:
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
        ) : undefined,
    },
  };

  return (
    <FadeIn className="space-y-4">
      <div className={OVERVIEW_KPI_GRID_CLASS}>
        {OVERVIEW_KPI_TILES.map((tile) => {
          const slice = tileData[tile.key];
          return (
            <KpiTile
              key={tile.key}
              label={tile.label}
              icon={tile.icon}
              accent={slice.accent ?? tile.accent}
              value={slice.value}
              sub={slice.sub}
              action={slice.action}
            />
          );
        })}
      </div>

      {/* Creator-cost time series (active window). Nested Suspense so the
          KPI strip paints as soon as the overview lands and the chart
          hydrates when its own series query resolves. */}
      <Suspense
        key={`creator-cost-${period}`}
        fallback={<CostChartSkeleton />}
      >
        <CreatorCostSeriesSection period={period} />
      </Suspense>
    </FadeIn>
  );
}

// ─── Creator-cost series (data-bearing, streamed via Suspense) ─────
//
// Hits `getHubCreatorCostSeries(period)` which is `unstable_cache`'d.
// Wrapped in `safeQueryOrNull` so a query failure degrades to a HubNotice
// instead of crashing the dashboard shell. Decimal-safe money throughout.
async function CreatorCostSeriesSection({
  period,
}: {
  period: DashboardPeriod;
}) {
  const { data, error } = await safeQueryOrNull(
    () => getHubCreatorCostSeries(period),
    "creator-hub.creatorCostSeries",
    8_000,
  );

  if (!data) {
    return (
      <HubNotice
        tone="amber"
        icon={AlertTriangle}
        title="Creator-cost series unavailable"
      >
        {error ?? "Backend unavailable."}
      </HubNotice>
    );
  }

  const padded = padCreatorCostSeries(data, period);
  const hourly = data.granularity === "hour";
  const chartData: CreatorCostChartPoint[] = padded.map((b) => ({
    bucket: hourly
      ? b.bucketIso.slice(11, 16) // "HH:MM"
      : b.bucketIso.slice(0, 10), // "YYYY-MM-DD"
    cost: b.costUsd,
  }));

  return (
    <HubCreatorCostChart
      data={chartData}
      title={
        hourly
          ? `Creator costs over time · ${hubWindowLabel(period)} (hourly)`
          : `Creator costs over time · ${hubWindowLabel(period)}`
      }
      subtitle="Converted deal payouts · House-funded tips · Leaderboard prize gross"
      hourlyXAxis={hourly}
    />
  );
}

// ─── b) Trends band (fixed 30 days, outside the period boundary) ───
//
// Reads the fixed-30d chart cache (`getHubCohortCharts` — always 30 daily
// buckets, single `unstable_cache` entry, 5-min revalidate), so a global
// chip flip never re-runs the chart scans.
async function TrendsSection() {
  const { data, error } = await safeQueryOrNull(
    () => getHubCohortCharts(),
    "creator-hub.trends30d",
    20_000,
  );

  if (!data) {
    console.error("[creator-hub] 30d trends failed:", error);
    return <BandUnavailable label="Trends" />;
  }

  return (
    <FadeIn className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <WagerChart
        title="Code-cohort wagers · last 30 days"
        data={data.dailyWagers}
      />
      <DepositsChart
        title="Code-cohort deposits · last 30 days"
        data={data.dailyDeposits}
      />
      <HubSignupsFtdsChart
        title="Sign-ups & FTDs · last 30 days"
        data={data.dailySignupsFtds}
      />
    </FadeIn>
  );
}

// ─── Top Creators list (own ranking window) ────────────────────────
//
// `getHubTopCreatorsByDeposits` runs a live PG leg; guarded with
// `safeQueryOrNull` so a transient failure degrades to a notice instead of
// crashing the hub (digest 491822067, 2026-07-05).
async function TopCreatorsList({ period }: { period: TopCreatorsPeriod }) {
  const { data, error } = await safeQueryOrNull(
    () => getHubTopCreatorsByDeposits(period),
    "creator-hub.topCreatorsByDeposits",
    8_000,
  );

  if (data == null) {
    console.error("[creator-hub] top creators by deposits failed:", error);
    return <BandUnavailable label="Top creators" />;
  }

  return <HubTopCreators creators={data} periodLabel={period} />;
}

// ─── c) Deal performance band (fixed 28 days, streamed) ────────────
//
// Fully guarded: `getFourWeekDealSummary` never throws (both heavy legs are
// safeQuery-bounded) and is cached (5-min revalidate); `safeQueryOrNull`
// here is a belt-and-suspenders boundary. A `null` / `backendUnavailable`
// result renders the degraded notice. The band is ALSO wrapped in a
// SectionErrorBoundary in the page body, so even an unexpected render throw
// degrades to the notice instead of crashing the hub.
async function FourWeekSection() {
  const { data } = await safeQueryOrNull(
    () => getFourWeekDealSummary(),
    "creator-hub.fourWeekSummary",
    50_000,
  );

  if (!data || data.backendUnavailable) {
    return <FourWeekUnavailable />;
  }

  // Per-creator drill-down lines for each tile's (i) popover — "where it's
  // coming from". Each tile sorts the same breakdown by its own metric.
  const nameOf = (r: (typeof data.breakdown)[number]) =>
    r.username ?? `#${r.userId.slice(0, 8)}`;
  const hasBreakdown = data.breakdown.length > 0;
  const activeLines = [...data.breakdown]
    .sort((a, b) => b.frameCount - a.frameCount)
    .map((r) => ({
      label: nameOf(r),
      value: `${r.frameCount} deal${r.frameCount === 1 ? "" : "s"}`,
      tone: "foreground" as const,
    }));
  const expectedLines = data.breakdown.map((r) => ({
    label: nameOf(r),
    value: formatCurrency(r.expectedWagerUsd),
    tone: "foreground" as const,
  }));
  const actualLines = [...data.breakdown]
    .sort((a, b) => b.actualWagerUsd - a.actualWagerUsd)
    .map((r) => ({
      label: nameOf(r),
      value: formatCurrency(r.actualWagerUsd),
      tone: "emerald" as const,
    }));
  const conversionLines = [...data.breakdown]
    .sort((a, b) => b.conversionRatio - a.conversionRatio)
    .map((r) => ({
      label: nameOf(r),
      value: `${r.conversionRatio.toFixed(2)}x`,
      tone: "foreground" as const,
    }));

  return (
    <FadeIn className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <KpiTile
        label="Active Creators"
        icon={Handshake}
        accent="blue"
        value={formatNumber(data.activeCreators)}
        sub="With a deal · last 28 days"
        action={
          hasBreakdown ? (
            <HubKpiInfoPopover
              title="Active creators · last 28 days"
              description="Every creator with at least one leaderboard-frame deal that ended in the last 28 days, and how many such deal frames each has."
              lines={activeLines}
              footer={{
                label: "Active creators",
                value: formatNumber(data.activeCreators),
              }}
            />
          ) : undefined
        }
      />
      <KpiTile
        label="Expected Wager"
        icon={TrendingUp}
        accent="blue"
        value={formatCurrency(data.expectedWagerUsd)}
        sub="To break even · 4 weeks"
        action={
          hasBreakdown ? (
            <HubKpiInfoPopover
              title="Expected wager · 4 weeks"
              description="Deal cost ÷ 7.5% house edge, per creator. Deal cost = withdraw cap + sponsored-weighted leaderboard house cost + tip/sponsor allowance (scaled across the frame's weeks; no daily-fill leg). Same per-frame model as the Past Deals tab, over deals that ended in the last 28 days."
              lines={expectedLines}
              footer={{
                label: "Total",
                value: formatCurrency(data.expectedWagerUsd),
              }}
            />
          ) : undefined
        }
      />
      <KpiTile
        label="Actual Wager"
        icon={Activity}
        accent="emerald"
        value={formatCurrency(data.actualWagerUsd)}
        sub="Driven in deal frames · 4 weeks"
        action={
          hasBreakdown ? (
            <HubKpiInfoPopover
              title="Actual wager · 4 weeks"
              description="Code-cohort wager driven inside each creator's deal frame(s) that ended in the last 28 days."
              lines={actualLines}
              footer={{
                label: "Total",
                value: formatCurrency(data.actualWagerUsd),
                tone: "emerald",
              }}
              ringClassName="focus-visible:ring-emerald-500/40"
            />
          ) : undefined
        }
      />
      <KpiTile
        label="Avg Conversion"
        icon={Percent}
        accent="blue"
        value={`${data.avgConversionRatio.toFixed(2)}x`}
        sub="Actual ÷ expected · avg"
        action={
          hasBreakdown ? (
            <HubKpiInfoPopover
              title="Conversion · 4 weeks"
              description="Actual wager ÷ expected wager per creator — the same 'Conversion' as the Profitability tab (≥ 1.00× = the deals paid for themselves). Headline is the plain average across creators with an expected wager."
              lines={conversionLines}
              footer={{
                label: "Average",
                value: `${data.avgConversionRatio.toFixed(2)}x`,
              }}
            />
          ) : undefined
        }
      />
    </FadeIn>
  );
}
