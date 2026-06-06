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

import { requireRole } from "@/lib/dal";
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
 * ACCESS: admin + creator_manager only (the layout enforces it; this page
 * adds the explicit DAL gate too — every protected page gates server-side
 * first per the house convention).
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
  await requireRole(["admin", "creator_manager"]);

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

  return (
    <FadeIn className="space-y-4">
      {/* KPI boxes — house-POV colors:
            • blue   = neutral count (creators / live / signups / FTDs)
            • emerald = house gain (affiliate wager / deposits)
            • rose   = house cost (creator cost)
          The four figures with no real windowed query render the honest
          em-dash placeholder (no fabricated numbers). */}
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
        />
        <HubKpiBox
          label={`Creator Cost · ${period}`}
          icon={Coins}
          accent="rose"
          value="—"
          placeholder
          placeholderNote="Windowed cost query pending"
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
          value="—"
          placeholder
          placeholderNote="Windowed signup query pending"
        />
        <HubKpiBox
          label={`New FTDs · ${period}`}
          icon={Check}
          accent="blue"
          value="—"
          placeholder
          placeholderNote="Windowed FTD query pending"
        />
        <HubKpiBox
          label={`Deposits · ${period}`}
          icon={ArrowDownToLine}
          accent="emerald"
          value="—"
          placeholder
          placeholderNote="Windowed deposits query pending"
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
        />
      </div>

      {/* 3-up row: Top Creators (hero) + Wager chart + Deposits chart. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
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
          <HubTopCreators creators={data.topCreators} />
        </div>

        {/* Wager chart — headline is the REAL windowed cohort wager total;
            the per-hour series isn't wired yet (honest placeholder body). */}
        <HubChartCard
          title="Wager"
          headline={
            data.affiliateWagerUsd != null
              ? formatCompactUsd(data.affiliateWagerUsd)
              : null
          }
          placeholderNote="Hourly breakdown not wired yet — total above is live."
        />

        {/* Deposits chart — no real windowed deposits figure yet, so both
            the headline and the series are honest placeholders. */}
        <HubChartCard
          title="Deposits"
          headline={null}
          placeholderNote="Windowed deposits query pending."
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
