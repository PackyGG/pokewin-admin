import { Suspense } from "react";
import {
  DollarSign,
  TrendingUp,
  Eye,
  UserPlus,
  Package,
  Swords,
} from "lucide-react";
import { getAnalyticsData } from "@/lib/queries/analytics";
import { compareAnalyticsOverview } from "@/lib/clickhouse/compare/analytics-overview";
import { resolveAdminRead } from "@/lib/clickhouse/resolve-read";
import { getAnalyticsDataFromClickHouse } from "@/lib/clickhouse/queries/analytics/overview";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import {
  getPnlBreakdownWindows,
  getPackBattlePurePnl,
} from "@/lib/queries/pnl";
import { formatCurrency } from "@/lib/utils/format";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { Skeleton } from "@/components/ui/skeleton";
import { StatCard } from "../dashboard/stat-card";
import { AnalyticsCharts } from "./charts";
import { FadeIn } from "@/components/fade-in";
import { PnlBreakdown } from "@/components/pnl-breakdown";
import { PeriodPnlBreakdown } from "@/components/period-pnl-breakdown";
import { PackBattlePurePnl } from "@/components/pack-battle-pure-pnl";
import type { AnalyticsPeriod } from "./types";

/**
 * Default tab — renders the headline KPIs and the daily chart grid.
 * The battle/pack breakdown sections live on the dedicated
 * "Pack & Battle" tab so the overview stays focused on high-level KPIs.
 */
export async function OverviewTab({ period }: { period: AnalyticsPeriod }) {
  // Fetch ONLY the period-keyed KPI bundle here. The windowed P&L
  // breakdown and the pack/battle pure P&L are period-INDEPENDENT
  // (fixed 24h/3d/7d windows), so each streams behind its own nested
  // Suspense below — the KPI strip + charts paint as soon as
  // getAnalyticsData resolves instead of waiting on the slowest of
  // three queries. safeQuery degrades a failure to a panel fallback
  // instead of escaping to the route error boundary.
  const { data, error } = await safeQuery(
    () =>
      resolveAdminRead<Awaited<ReturnType<typeof getAnalyticsData>>>(
        "analytics_overview",
        {
          pg: () => getAnalyticsData(period),
          ch: async () =>
            getAnalyticsDataFromClickHouse(period, await getExcludedUserIds()),
        },
      ),
    null,
    "analytics.overview",
    REWARD_QUERY_TIMEOUT_MS,
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Analytics overview"
        hint="The overview metrics query failed — refresh or switch period to retry."
        size="panel"
      />
    );
  }

  // Comparison-mode ClickHouse twin (fire-and-forget). No-op unless the
  // `analytics_overview` surface is in `comparison` mode; never awaited,
  // swallows its own errors, and never affects the rendered Postgres payload.
  void compareAnalyticsOverview(period, data);

  const totalWager = data.packWager + data.battleWager + data.upgraderWager;
  const packPct =
    totalWager > 0 ? ((data.packWager / totalWager) * 100).toFixed(1) : "0";
  const battlePct =
    totalWager > 0 ? ((data.battleWager / totalWager) * 100).toFixed(1) : "0";
  const upgraderPct =
    totalWager > 0 ? ((data.upgraderWager / totalWager) * 100).toFixed(1) : "0";
  const packBorrowPct =
    data.packWager > 0
      ? ((data.packWagerBorrowed / data.packWager) * 100).toFixed(1)
      : "0";
  const battleBorrowPct =
    data.battleWager > 0
      ? ((data.battleWagerBorrowed / data.battleWager) * 100).toFixed(1)
      : "0";

  return (
    <div className="space-y-6">
      <div className="grid gap-3 grid-cols-2 sm:gap-4 md:grid-cols-2 lg:grid-cols-3">
        <StatCard
          title="Realized Profit"
          animatedValue={data.realizedProfit}
          formatKind="currency"
          subtitle="See breakdown below"
          icon={TrendingUp}
          color="green"
        />
        <StatCard
          title="GGR (Gross Gaming Revenue)"
          animatedValue={data.ggr}
          formatKind="currency"
          subtitle={`Wager − gaming payout · ${formatCurrency(totalWager)} wagered`}
          icon={DollarSign}
          color={data.ggr >= 0 ? "emerald" : "rose"}
        />
        <StatCard
          title="NGR (Net Gaming Revenue)"
          animatedValue={data.ngr}
          formatKind="currency"
          subtitle="GGR − reward cost (incl. net rain)"
          icon={DollarSign}
          color={data.ngr >= 0 ? "emerald" : "rose"}
        />
        <StatCard
          title="Unique Visitors"
          animatedValue={data.uniqueVisitors}
          formatKind="number"
          subtitle="Distinct users with transactions"
          icon={Eye}
          color="cyan"
        />
        <StatCard
          title="New Signups"
          animatedValue={data.newSignups}
          formatKind="number"
          subtitle={`${data.uniqueVisitors > 0 ? ((data.newSignups / data.uniqueVisitors) * 100).toFixed(1) : "0"}% of active users`}
          icon={UserPlus}
          color="purple"
        />
        <StatCard
          title="Pack Wagers"
          animatedValue={data.packWager}
          formatKind="currency"
          subtitle={`${packPct}% of total wagers`}
          icon={Package}
          color="orange"
        >
          <p className="text-stat-label mt-1">
            {formatCurrency(data.packWagerBorrowed)} borrowed ({packBorrowPct}%)
          </p>
        </StatCard>
        <StatCard
          title="Battle Wagers"
          animatedValue={data.battleWager}
          formatKind="currency"
          subtitle={`${battlePct}% of total wagers`}
          icon={Swords}
          color="pink"
        >
          <p className="text-stat-label mt-1">
            {formatCurrency(data.battleWagerBorrowed)} borrowed (
            {battleBorrowPct}%)
          </p>
        </StatCard>
        <StatCard
          title="Upgrader Wagers"
          animatedValue={data.upgraderWager}
          formatKind="currency"
          subtitle={`${upgraderPct}% of total wagers`}
          icon={TrendingUp}
          color="cyan"
        />
      </div>

      <FadeIn>
        <PnlBreakdown
          total={data.realizedProfit}
          breakdown={data.realizedProfitBreakdown}
        />
      </FadeIn>

      <Suspense fallback={<PnlPanelSkeleton bodyHeight={560} />}>
        <OverviewPeriodPnl />
      </Suspense>

      {/* Pack & Battle PURE P&L — raw outcome only, no rewards / no
          upgrader. Separate from PeriodPnlBreakdown which is the full
          house balance-sheet view; this panel isolates gambling
          margin so admins can spot pack/battle edge drift without
          rewards muddying the signal. */}
      <Suspense fallback={<PnlPanelSkeleton bodyHeight={360} />}>
        <OverviewPackBattlePure />
      </Suspense>

      <FadeIn>
        <AnalyticsCharts data={data.daily} />
      </FadeIn>
    </div>
  );
}

/**
 * Period-independent windowed P&L breakdown (fixed 24h / 3d / 7d) —
 * its own async segment behind a nested Suspense so the period-keyed
 * KPI strip above never waits on it. Renders the exact same
 * `<FadeIn><PeriodPnlBreakdown /></FadeIn>` output as before; a
 * failed query degrades to a panel-sized fallback.
 */
async function OverviewPeriodPnl() {
  const { data, error } = await safeQuery(
    () => getPnlBreakdownWindows(),
    null,
    "analytics.overview.pnlWindows",
    REWARD_QUERY_TIMEOUT_MS,
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Period P&L breakdown"
        hint="The windowed P&L query failed — other sections still rendered. Refresh to retry."
        size="panel"
      />
    );
  }
  return (
    <FadeIn>
      <PeriodPnlBreakdown data={data} />
    </FadeIn>
  );
}

/**
 * Period-independent Pack & Battle pure P&L — same nested-Suspense
 * streaming + safeQuery degradation as OverviewPeriodPnl above.
 */
async function OverviewPackBattlePure() {
  const { data, error } = await safeQuery(
    () => getPackBattlePurePnl(),
    null,
    "analytics.overview.packBattlePure",
    REWARD_QUERY_TIMEOUT_MS,
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Pack & Battle raw P&L"
        hint="The pure P&L query failed — other sections still rendered. Refresh to retry."
        size="panel"
      />
    );
  }
  return (
    <FadeIn>
      <PackBattlePurePnl data={data} />
    </FadeIn>
  );
}

/**
 * Footprint-matched Suspense fallback for the two P&L panels — same
 * rounded-2xl gradient-card chrome as the real panels (heading line,
 * description line, table block) so the swap into real content stays
 * dimension-stable. Inline height mirrors the SkeletonChart pattern
 * in src/components/ux/skeleton.tsx.
 */
function PnlPanelSkeleton({ bodyHeight }: { bodyHeight: number }) {
  return (
    <div className="rounded-2xl border bg-gradient-to-br from-card via-card to-card/80 p-4 sm:p-5">
      <Skeleton className="h-5 w-48 rounded" />
      <Skeleton className="mt-1.5 h-3 w-full max-w-md rounded" />
      <Skeleton
        className="mt-4 w-full rounded-xl"
        style={{ height: bodyHeight }}
      />
    </div>
  );
}

// P&L Breakdown panel ("Where the P&L comes from") lives in the
// shared component src/components/pnl-breakdown.tsx.
