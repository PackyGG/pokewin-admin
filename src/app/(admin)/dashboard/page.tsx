import { Suspense } from "react";
import { LayoutDashboard, LineChart } from "lucide-react";
import {
  getDashboardStats,
  getDashboardKpiStats,
  getActiveRain,
} from "@/lib/queries/dashboard";
import { getUpgraderStats } from "@/lib/queries/dashboard-upgrader";
import { getDailyPnl } from "@/lib/queries/pnl";
import { getTodayPnl } from "@/lib/queries/dashboard-today-pnl";
import { getAvgPnl7d } from "@/lib/queries/dashboard-avg-pnl-7d";
import { getRealizedPnlSnapshot } from "@/lib/queries/_realized-pnl";
import { getRewardCostsToday } from "@/lib/queries/dashboard-reward-costs-today";
import { getCreatorCostsToday } from "@/lib/queries/dashboard-creator-costs-today";
import { getAffiliateReferredPnlToday } from "@/lib/queries/dashboard-affiliate-referred-pnl-today";
import { getChatMessagesToday } from "@/lib/queries/dashboard-chat-messages-today";
import { getCryptoFeeProfitCounter } from "@/lib/queries/dashboard-crypto-fee-counter";
import { compareDashboardTodayPnl } from "@/lib/clickhouse/compare/dashboard-today-pnl";
import { compareDashboardAvgPnl7d } from "@/lib/clickhouse/compare/dashboard-avg-pnl-7d";
import { compareDashboardDailyPnl } from "@/lib/clickhouse/compare/dashboard-daily-pnl";
import { compareDashboardUpgraderStats } from "@/lib/clickhouse/compare/dashboard-upgrader-stats";
import { compareDashboardCreatorCostsToday } from "@/lib/clickhouse/compare/dashboard-creator-costs-today";
import { compareDashboardAffiliateReferredPnlToday } from "@/lib/clickhouse/compare/dashboard-affiliate-referred-pnl-today";
import { compareDashboardChatMessagesToday } from "@/lib/clickhouse/compare/dashboard-chat-messages-today";
import { requirePageAccess } from "@/lib/dal";
import { formatRelative } from "@/lib/utils/format";
import { LoadTimeIndicator } from "./load-time-indicator";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import {
  DashboardKpiSection,
  type KpiSnapshotValues,
  type CryptoFeeKpi,
} from "./dashboard-kpi-section";
import { buildKpiWindowPayload } from "./kpi-window-data";
import { TodayPnlStatCard } from "./today-pnl-stat-card";
import { RewardCostsTodayCard } from "./reward-costs-today-card";
import { CreatorCostsTodayCard } from "./creator-costs-today-card";
import { ChatMessagesTodayCard } from "./chat-messages-today-card";
import { AutoRefresh } from "./auto-refresh";
import {
  WagerChart,
  WagerAttributionChart,
  DepositsChart,
  SignupsChart,
  FtdsChart,
  PnlChart,
  ActiveDepositorsChart,
} from "./charts";
// RecentActivity moved into the admin shell layout (DockedRecentActivity).
// The widget now docks on every admin page so the dashboard body no longer
// renders the in-page Activity card.
// LiveMoneyChat also lives in the admin shell layout (same dock pattern).
import { UpgraderStatsSection } from "./upgrader-stats";
import { ActiveRainChip } from "./active-rain-chip";
import { PageHero, PageHeroIdentity, SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import {
  SkeletonKpiStrip,
  SkeletonChart,
} from "@/components/ux";
import { Skeleton } from "@/components/ui/skeleton";
import { ChartRowSkeleton, UpgraderPanelSkeleton } from "./dashboard-skeletons";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  await requirePageAccess("/dashboard");

  // Trend charts + Wager Attribution are ALWAYS 30-day daily buckets (fixed).
  // The headline KPI boxes are independent — they default to "today" (since
  // 00:00 UTC) via getDashboardKpiStats and carry their own per-box today/24h
  // toggle, fetching the 24h window lazily on first toggle.

  // The live feeds (Recent Activity, Live Money Movements) all live in
  // the admin shell now as docked right-edge widgets and bootstrap their
  // own snapshots on the client (SSE / polling), so the dashboard's 60s
  // refresh stays scoped to KPI numbers only.
  return (
    // `pr-*` reserves a comfortable gutter on the right so the KPI strips,
    // charts, and cards never run flush under the fixed right-edge docked
    // rail (Live / Recent / Chat tabs sit at `right-0`). The gutter widens
    // at wide breakpoints — where there's room — so an open 320px rail panel
    // doesn't crowd the card edge; on smaller laptops it stays a small
    // clearance for the always-present collapsed tab.
    <div className="space-y-6 pr-6 sm:pr-10 xl:pr-12 2xl:pr-16">
      {/* Dashboard polls at 60s for the KPI numbers only — KPIs settle
          slowly and the docked widgets own their own data on the client,
          so this refresh no longer re-queries any of the live feeds. */}
      <AutoRefresh intervalMs={60_000} />

      <PageHero>
        <PageHeroIdentity
          icon={LayoutDashboard}
          title="Dashboard"
          subtitle="Live platform overview — revenue, users, and recent activity."
          // Top-right action chips: the live Active Rain entrant count and
          // the data-freshness ("Updated Ns ago") indicator, each behind its
          // own tiny Suspense so the hero paints instantly. Wrap so they sit
          // side by side and wrap onto a second line on narrow phones.
          action={
            <div className="flex flex-wrap items-center gap-2">
              <Suspense
                fallback={
                  <Skeleton className="h-9 w-44 rounded-full" />
                }
              >
                <DashboardActiveRain />
              </Suspense>
              <Suspense
                fallback={
                  <Skeleton className="h-[26px] w-40 rounded-full" />
                }
              >
                <DashboardLoadTime />
              </Suspense>
            </div>
          }
        />
      </PageHero>

      {/* TODAY BOXES — P&L Today + Reward Costs + Creators Costs + Chat
          Messages, in that order, at the top. All four use the CURRENT
          CALENDAR DAY since 00:00 UTC (NOT a rolling past-24h window) and
          share the same UTC-midnight boundary. Each streams behind its OWN
          Suspense + safeQuery. Full-width on mobile, 2-up at sm, 4-up at xl. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4">
        <Suspense
          fallback={<Skeleton className="h-[148px] w-full rounded-xl" />}
        >
          <DashboardTodayPnl />
        </Suspense>
        <Suspense
          fallback={<Skeleton className="h-[148px] w-full rounded-xl" />}
        >
          <DashboardRewardCostsToday />
        </Suspense>
        <Suspense
          fallback={<Skeleton className="h-[148px] w-full rounded-xl" />}
        >
          <DashboardCreatorCostsToday />
        </Suspense>
        <Suspense
          fallback={<Skeleton className="h-[148px] w-full rounded-xl" />}
        >
          <DashboardChatMessagesToday />
        </Suspense>
      </div>

      {/* KPI boxes — period-bound (GGR, Wager [Total + Organic merged into
          one box], Deposits, Withdrawals) with a per-box today/24h toggle,
          plus the window-independent snapshot boxes (Total Users, FTDs,
          Depositors, Avg Deposit, Deposits/Hour, Avg RTP, Avg P&L 7d). DEFAULTS to
          "today" (loaded eagerly here); the rolling 24h window is fetched
          lazily on the first toggle inside the client section
          (active-timeframe-only).

          NOT keyed on any global selector — these boxes own their own today/24h
          window via the toggle next to each title. Streams behind its own Suspense
          so the today-window aggregate never blocks the 3 cost cards above;
          the skeleton mirrors the 4-up period strip + 6-up snapshot strip. */}
      <Suspense
        fallback={
          <>
            <SkeletonKpiStrip count={4} />
            <SkeletonKpiStrip count={8} />
          </>
        }
      >
        <DashboardKpiBoxes />
      </Suspense>

      {/* Upgrader Stats + Wager Attribution — paired 50/50 row that
          sits between the KPI strips and the trend graphs. Each
          streams behind its own Suspense:
            • Upgrader Stats is a separate query (getUpgraderStats),
              so its scan never blocks the headline KPIs.
            • Wager Attribution shares the cached getDashboardStats
              with the KPI strips + charts — the call dedupes
              cross-segment, so it's a free render.
          Stacks single-column on smaller screens so each card keeps
          a usable width. */}
      {/* Both Suspense fallbacks use the SAME height so the grid row
          stays stable while one side loads ahead of the other —
          previously the row jumped from the shorter skeleton up to
          the chart's natural height when the chart resolved, which
          briefly cropped the upgrader content. The shared
          `min-h-[400px]` on the row guarantees the layout reserves
          the chart's natural height from the first paint, regardless
          of which side resolves first. */}
      <div className="grid min-h-[400px] gap-3 sm:gap-4 lg:grid-cols-2 lg:items-stretch">
        {/* Upgrader Stats is a lifetime aggregate (period-independent), so it
            never re-suspends on a chip click — its skeleton only shows on the
            cold load. The fallback mirrors the panel's real internal layout
            (hero / volume / activity rows + hit-rate band) so the swap is
            shift-free instead of a flat grey block snapping into a dense
            panel. */}
        <Suspense fallback={<UpgraderPanelSkeleton />}>
          <DashboardUpgraderSection />
        </Suspense>
        {/* Wager Attribution — always 30-day daily buckets (same as Trends). */}
        <Suspense
          fallback={
            <SkeletonChart
              height={400}
              className="h-full min-h-[400px] rounded-xl"
            />
          }
        >
          <DashboardWagerAttribution />
        </Suspense>
      </div>

      {/* Charts. Three-up at lg+ but stacks to a single column on
          phones so each chart keeps a readable height (Recharts crushes
          when forced into a tight grid cell). At md we go 2-up so the
          row stays balanced before we have room for the third. The
          Wager Attribution chart moved up next to the Upgrader Stats
          section, so Trends is now two 3-up rows. */}
      <div className="space-y-3">
        <SectionHeading icon={LineChart} title="Trends" />
        {/* Row 1: Wagers · Deposits · FTDs.
            Row 2: Daily P&L · Signups · Depositors.

            The five cached-stats charts (everything EXCEPT Daily P&L) are
            backed by the React-cached getDashboardStats — which the KPI
            strips already triggered — so this outer boundary resolves as
            soon as that shared aggregate is ready and paints all five
            charts together. The Daily P&L chart is the single heavy leg
            (its own lifetime-scan getDailyPnl), so it streams behind its
            OWN nested <Suspense> INSIDE the grid (row 2, col 1): the five
            fast charts no longer wait on the slow P&L scan, and the P&L
            cell shows a chart skeleton until getDailyPnl resolves.

            Not period-keyed: the trend charts stay on screen during refresh
            rather than flashing skeletons. The skeleton is for the cold load
            only and mirrors the chart-card chrome (rounded-xl, faux bars) so
            it doesn't pop a flat block into a chart. */}
        <Suspense
          fallback={
            <>
              <ChartRowSkeleton count={3} height={300} />
              <ChartRowSkeleton count={3} height={300} />
            </>
          }
        >
          <DashboardCharts />
        </Suspense>
      </div>

      {/* Recent Activity moved into the admin shell as the middle
          docked widget (<DockedRecentActivity />) so every admin page
          gets the same live event feed on the right edge. The
          dashboard body no longer renders the in-page card. */}

    </div>
  );
}

/** Fixed period for trend charts — always 30-day daily buckets. */
const DASHBOARD_CHART_PERIOD = "30d" as const;

/**
 * Data-freshness chip for the hero action slot. Streams behind its own tiny
 * Suspense; reads the same React-cached getDashboardStats used by the charts,
 * so it adds no extra query — it just surfaces the generatedAt timestamp the
 * aggregate already records for the "Updated Ns ago" label.
 */
async function DashboardLoadTime() {
  // Wrapped in safeQuery so a failing/slow stats aggregate degrades this
  // hero chip to nothing instead of throwing up the route boundary (the
  // chip is decorative — a missing freshness indicator must never take
  // the page down). The KPI strip surfaces the same failure as a tile
  // fallback, so the operator still sees the degraded state there.
  const { data: stats, error } = await safeQuery(
    () => getDashboardStats(DASHBOARD_CHART_PERIOD),
    null,
    "dashboard.loadTime",
    REWARD_QUERY_TIMEOUT_MS,
  );
  if (error || !stats) return null;
  return (
    <LoadTimeIndicator
      generatedAt={stats.generatedAt}
      // Formatted server-side so the first client paint is byte-identical to
      // the SSR markup (no #418); the client re-derives it after mount.
      initialRelative={formatRelative(stats.generatedAt)}
    />
  );
}

/**
 * Eager-renders the dashboard's KPI boxes for the DEFAULT "today" window
 * (since 00:00 UTC) and hands the client section both the today payload and
 * the window-independent snapshot values. The client section adds the
 * per-box today/24h toggle and fetches the rolling-24h payload lazily on the
 * first toggle (active-timeframe-only — the 24h aggregate never runs here).
 *
 * Wrapped in safeQuery so a failing today-window aggregate degrades to a
 * single panel fallback instead of escaping to the route error boundary
 * (which would white-screen the whole dashboard — the failure mode this
 * page hit in prod). The snapshot values come from the SAME eager "today"
 * stats (they're lifetime / fixed-window figures, so the window doesn't
 * change them) — no extra query.
 */
async function DashboardKpiBoxes() {
  const [
    payloadResult,
    statsResult,
    avgPnl7dResult,
    lifetimePnlResult,
    cryptoFeeResult,
  ] = await Promise.all([
    // Period-bound box values + GGR legs for the eager "today" window.
    safeQuery(
      () => buildKpiWindowPayload("today"),
      null,
      "dashboard.kpiToday",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    // Snapshot (lifetime / fixed-window) figures — read off the same cached
    // today aggregate so no second roundtrip is added.
    safeQuery(
      () => getDashboardKpiStats("today"),
      null,
      "dashboard.kpiSnapshot",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getAvgPnl7d(),
      { totalPnl7d: 0, avgDailyPnl: 0 },
      "dashboard.avgPnl7d",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getRealizedPnlSnapshot(),
      {
        pnl: 0,
        totalDeposited: 0,
        totalWithdrawn: 0,
        userBalance: 0,
        inventory: 0,
        vouchers: 0,
        unclaimedRakeback: 0,
      },
      "dashboard.lifetimePnl",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    // Crypto Fee counter — anchored, monotonic, durable (admin-DB high-water).
    // Independent of the period payload; degrades to the muted slot on
    // failure (available:false) so a slow/failed crypto read never blocks or
    // breaks the headline KPI boxes.
    safeQuery(
      () => getCryptoFeeProfitCounter(),
      null,
      "dashboard.cryptoFeeCounter",
      REWARD_QUERY_TIMEOUT_MS,
    ),
  ]);
  if (
    payloadResult.error ||
    !payloadResult.data ||
    statsResult.error ||
    !statsResult.data
  ) {
    return (
      <TileErrorFallback
        label="Platform KPIs"
        hint="A metrics query failed while loading the KPI boxes — other sections still rendered. Refresh to retry."
        kind={payloadResult.kind ?? statsResult.kind ?? undefined}
        size="panel"
      />
    );
  }
  const today = payloadResult.data;
  const stats = statsResult.data;
  const avgPnl7d = avgPnl7dResult.data ?? { totalPnl7d: 0, avgDailyPnl: 0 };
  const lifetimePnl = lifetimePnlResult.data?.pnl ?? 0;

  // CQRS rollout: in `comparison` mode, run the ClickHouse Avg-P&L-7d path
  // side-by-side and LOG drift. Fire-and-forget + never-throwing — the served
  // snapshot below stays 100% Postgres. No-op unless the flag is `comparison`.
  void compareDashboardAvgPnl7d(avgPnl7d);

  // Snapshot (lifetime / fixed-window) figures — the window toggle doesn't
  // change them, so they read the same for today and 24h. Deposits/Hour is a
  // FIXED 24h / 7d rate (count ÷ hours).
  const snapshot: KpiSnapshotValues = {
    usersTotal: stats.users.total,
    usersToday: stats.users.today,
    usersWeek: stats.users.week,
    ftds24h: stats.financials.ftds24h,
    ftdTotal24h: stats.financials.ftdTotal24h,
    ftdAvg24h: stats.financials.ftdAvg24h,
    uniqueDepositors: stats.financials.uniqueDepositors,
    depositorsPctOfUsers:
      stats.users.total > 0
        ? (stats.financials.uniqueDepositors / stats.users.total) * 100
        : null,
    avgDeposit: stats.financials.avgDeposit,
    depositsPerHour24h: stats.depositCount24h / 24,
    depositsPerHour7d: stats.depositCount7d / (7 * 24),
    avgRtp:
      stats.financials.totalWagered > 0
        ? (stats.financials.totalWon / stats.financials.totalWagered) * 100
        : 0,
    totalPnl7d: avgPnl7d.totalPnl7d,
    avgDailyPnl7d: avgPnl7d.avgDailyPnl,
    totalPnlLifetime: lifetimePnl,
  };

  // Crypto Fee box payload. A failed/degraded read (cryptoFeeResult.data ===
  // null) OR an explicitly-unavailable counter (admin row missing) both
  // render the muted slot via `available: false`.
  const c = cryptoFeeResult.data;
  const cryptoFee: CryptoFeeKpi = c
    ? {
        available: c.available,
        totalFeeUsd: c.totalFeeUsd,
        depositFeeUsd: c.depositFeeUsd,
        withdrawalFeeUsd: c.withdrawalFeeUsd,
        depositBps: c.depositBps,
        withdrawalBps: c.withdrawalBps,
        sinceLabel: c.sinceLabel,
      }
    : {
        available: false,
        totalFeeUsd: 0,
        depositFeeUsd: 0,
        withdrawalFeeUsd: 0,
        depositBps: 0,
        withdrawalBps: 0,
        sinceLabel: "",
      };

  return (
    <DashboardKpiSection
      today={today}
      snapshot={snapshot}
      cryptoFee={cryptoFee}
    />
  );
}

/**
 * Upgrader stats section — wager / payouts / P&L / edge / bets / avg
 * bet / unique players. Its own query (separate from
 * getDashboardStats) so the headline KPI strips don't pay for the
 * upgrader scan. The query is per-request cached via `cache()` so
 * mounting the section twice in one render is free.
 */
async function DashboardUpgraderSection() {
  // getUpgraderStats is already to_regclass-guarded (it returns zeroed
  // stats on a pre-upgrader DB rather than throwing 42P01), but wrap it
  // in safeQuery anyway so ANY other failure (a slow scan, a connection
  // blip) degrades this panel to a fallback instead of crashing the
  // route. Panel-size fallback fills the 50/50 row slot.
  const { data: stats, error, kind } = await safeQuery(
    () => getUpgraderStats(),
    null,
    "dashboard.upgrader",
    REWARD_QUERY_TIMEOUT_MS,
  );
  if (error || !stats) {
    return (
      <TileErrorFallback
        label="Upgrader Stats"
        hint="The upgrader aggregate failed to load — other sections still rendered. Refresh to retry."
        kind={kind ?? undefined}
        size="panel"
        className="h-full min-h-[400px]"
      />
    );
  }
  // CQRS rollout: in `comparison` mode, run the ClickHouse upgrader-stats path
  // side-by-side and LOG drift. Fire-and-forget + never-throwing — the served
  // panel below stays 100% Postgres. No-op unless the flag is `comparison`.
  void compareDashboardUpgraderStats({
    wager: stats.wager,
    payouts: stats.payouts,
    pnl: stats.pnl,
    bets: stats.bets,
    uniquePlayers: stats.uniquePlayers,
    wins: stats.wins,
    losses: stats.losses,
  });
  // The panel is itself `h-full`, so it stretches to fill the 50/50 row cell.
  return <UpgraderStatsSection stats={stats} />;
}

/**
 * P&L Today tile — house P&L for the current calendar day since 00:00
 * UTC (NOT a rolling past-24h window). Its own standalone query
 * (getTodayPnl, cached 60s + keyed on the UTC day boundary), wrapped in
 * safeQuery so a slow today-window scan degrades to a tile fallback
 * instead of crashing the dashboard. The query reuses the canonical
 * windowed-delta P&L formula (calculateWindowedPnl), so this reconciles
 * with the period-P&L card + daily-P&L chart.
 */
async function DashboardTodayPnl() {
  const { data, error, kind } = await safeQuery(
    () => getTodayPnl(),
    null,
    "dashboard.todayPnl",
    REWARD_QUERY_TIMEOUT_MS,
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="P&L Today"
        hint="The today-window P&L scan timed out — refresh to retry."
        kind={kind ?? undefined}
        size="compact"
      />
    );
  }
  // CQRS rollout: in `comparison` mode, run the ClickHouse windowed-P&L path
  // side-by-side and LOG drift. Fire-and-forget + never-throwing — the served
  // tile below stays 100% Postgres. No-op unless the flag is `comparison`.
  void compareDashboardTodayPnl({
    deposits: data.deposits,
    withdrawals: data.withdrawals,
    balanceChange: data.balanceChange,
    inventoryChange: data.inventoryChange,
    voucherChange: data.voucherChange,
    pnl: data.pnl,
    dayStartIso: data.dayStartIso,
  });
  // dayStartIso is "YYYY-MM-DDT00:00:00.000Z"; the YYYY-MM-DD slice is the
  // UTC calendar day this P&L covers (matches the window boundary exactly).
  const dayLabel = data.dayStartIso.slice(0, 10);
  return (
    <TodayPnlStatCard
      pnl={data.pnl}
      deposits={data.deposits}
      withdrawals={data.withdrawals}
      balanceChange={data.balanceChange}
      inventoryChange={data.inventoryChange}
      voucherChange={data.voucherChange}
      dayLabel={dayLabel}
    />
  );
}

/**
 * Reward Costs Today tile — house reward/retention spend for the current
 * calendar day since 00:00 UTC (NOT a rolling past-24h window). Its own
 * standalone query (getRewardCostsToday, cached 60s + keyed on the UTC day
 * boundary), wrapped in safeQuery so a slow today-window scan degrades to a
 * tile fallback instead of crashing the dashboard. Reuses the canonical
 * reward-cost definitions (REWARD_PAYOUT_TYPES + the manual-voucher /
 * counted-adjustment carve-outs + the daily-pack giveaway), with rain as
 * the owner-confirmed flat $2/hr model and affiliate commissions excluded.
 */
async function DashboardRewardCostsToday() {
  const { data, error, kind } = await safeQuery(
    () => getRewardCostsToday(),
    null,
    "dashboard.rewardCostsToday",
    REWARD_QUERY_TIMEOUT_MS,
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Reward Costs"
        hint="The today-window reward-cost scan timed out — refresh to retry."
        kind={kind ?? undefined}
        size="compact"
      />
    );
  }
  // dayStartIso is "YYYY-MM-DDT00:00:00.000Z"; the YYYY-MM-DD slice is the
  // UTC calendar day this cost covers (matches the window boundary exactly).
  const dayLabel = data.dayStartIso.slice(0, 10);
  return (
    <RewardCostsTodayCard
      total={data.total}
      lines={data.lines}
      dayLabel={dayLabel}
      hoursElapsed={data.hoursElapsed}
    />
  );
}

/**
 * Creators Costs Today tile — house spend on CREATOR activity for the
 * current calendar day since 00:00 UTC (NOT a rolling past-24h window;
 * shares the boundary with the Reward Costs / P&L Today tiles). Its own
 * standalone query (getCreatorCostsToday, cached 60s + keyed on the UTC day
 * boundary), wrapped in safeQuery so a slow today-window scan degrades to a
 * tile fallback instead of crashing the dashboard. Reuses the canonical
 * creator-cost definitions: the Creator Deal Payouts withdrawal CTE, the
 * tips-sponsor-spend tip leg, and affiliate_leaderboard_prize payouts split
 * by the same sponsored-% house-share logic as creators/leaderboard-cost.
 */
async function DashboardCreatorCostsToday() {
  // The creator-cost figures drive the card; the affiliate-referred-players
  // P&L is an INDEPENDENT corner indicator. Both are today-windowed + cached
  // 60s and run in parallel, each behind its own safeQuery so they fail
  // independently: a failing/slow P&L scan only drops the small corner badge
  // (passed as null), it never takes the cost card down.
  const [costsResult, pnlResult] = await Promise.all([
    safeQuery(
      () => getCreatorCostsToday(),
      null,
      "dashboard.creatorCostsToday",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getAffiliateReferredPnlToday(),
      null,
      "dashboard.affiliateReferredPnlToday",
      REWARD_QUERY_TIMEOUT_MS,
    ),
  ]);
  if (costsResult.error || !costsResult.data) {
    return (
      <TileErrorFallback
        label="Creators Costs"
        hint="The today-window creator-cost scan timed out — refresh to retry."
        kind={costsResult.kind ?? undefined}
        size="compact"
      />
    );
  }
  const data = costsResult.data;
  // CQRS rollout: in `comparison` mode, run the ClickHouse twins side-by-side
  // and LOG drift. Fire-and-forget + never-throwing — the served card below
  // stays 100% Postgres. No-op unless each flag is `comparison`. The
  // affiliate-referred badge is an independent surface keyed off its own flag.
  void compareDashboardCreatorCostsToday({
    total: data.total,
    creatorWithdrawals: data.creatorWithdrawals,
    tips: data.tips,
    leaderboardGross: data.leaderboardGross,
    dayStartIso: data.dayStartIso,
  });
  if (pnlResult.data) {
    void compareDashboardAffiliateReferredPnlToday({
      pnl: pnlResult.data.pnl,
      dayStartIso: pnlResult.data.dayStartIso,
    });
  }
  // dayStartIso is "YYYY-MM-DDT00:00:00.000Z"; the YYYY-MM-DD slice is the
  // UTC calendar day this cost covers (matches the window boundary exactly).
  const dayLabel = data.dayStartIso.slice(0, 10);
  return (
    <CreatorCostsTodayCard
      total={data.total}
      lines={data.lines}
      dayLabel={dayLabel}
      // Aggregate house P&L on affiliate-referred players for the same "today"
      // window — null when the scan failed/degraded (badge then omitted).
      affiliateReferredPnl={pnlResult.data?.pnl ?? null}
    />
  );
}

/**
 * Chat Messages Today tile — on-site chat volume for the current calendar
 * day since 00:00 UTC. Standalone query (getChatMessagesToday, 60s cache +
 * UTC day key), streamed in its own Suspense.
 */
async function DashboardChatMessagesToday() {
  const { data, error, kind } = await safeQuery(
    () => getChatMessagesToday(),
    null,
    "dashboard.chatMessagesToday",
    REWARD_QUERY_TIMEOUT_MS,
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Chat Messages"
        hint="The today-window chat scan timed out — refresh to retry."
        kind={kind ?? undefined}
        size="compact"
      />
    );
  }
  // CQRS rollout: comparison-mode ClickHouse twin (fire-and-forget, never
  // throws). No-op unless `dashboard_chat_messages_today` is `comparison`.
  void compareDashboardChatMessagesToday({
    messageCount: data.messageCount,
    uniqueChatters: data.uniqueChatters,
    deletedCount: data.deletedCount,
    dayStartIso: data.dayStartIso,
  });
  const dayLabel = data.dayStartIso.slice(0, 10);
  return (
    <ChatMessagesTodayCard
      messageCount={data.messageCount}
      uniqueChatters={data.uniqueChatters}
      deletedCount={data.deletedCount}
      dayLabel={dayLabel}
    />
  );
}

/**
 * Active Rain box. Its own lightweight query (a single rains row), streamed
 * behind its own Suspense so it never blocks the heavy stats aggregate and
 * refreshes on the dashboard's 60s tick.
 */
async function DashboardActiveRain() {
  // Wrapped in safeQuery so a failed rains lookup degrades this hero chip
  // to its idle ("No active rain") state instead of throwing up the route
  // boundary — a decorative chip must never take the page down. On error
  // we pass `null`, which ActiveRainChip already renders as the idle chip.
  const { data: rain } = await safeQuery(
    () => getActiveRain(),
    null,
    "dashboard.activeRain",
    REWARD_QUERY_TIMEOUT_MS,
  );
  return <ActiveRainChip rain={rain} />;
}

/**
 * Trend charts in two rows:
 *   Row 1 (3): Wagers · Deposits · FTDs              — cached getDashboardStats
 *   Row 2 (3): Daily P&L · Signups · Depositors      — P&L from getDailyPnl
 *
 * The five non-P&L charts read from the React-cached getDashboardStats — the
 * SAME aggregate the KPI strips already triggered — so this component awaits
 * ONLY that (the call dedupes; it's effectively free here) and paints all
 * five charts as soon as it's ready. The Daily P&L chart is the one heavy leg
 * (its own lifetime-scan getDailyPnl), so it is NO LONGER awaited here: it
 * streams behind its own nested <Suspense> (DashboardDailyPnlChart) at row 2 /
 * col 1, so the slow P&L scan can't hold back the five fast charts. The
 * nested Suspense fallback is a single chart-card skeleton occupying exactly
 * that one grid cell, so the row layout never shifts.
 *
 * The Wager Attribution chart used to live as a third full-width row here; it
 * was promoted next to the Upgrader Stats section.
 */
async function DashboardCharts() {
  // getDashboardStats backs the wager/deposit/ftds/signup/depositor charts.
  // Always 30-day daily buckets — NOT tied to any global period selector.
  // Wrapped in safeQuery so a throw degrades to a fallback instead of
  // escaping to the route error boundary (which would white-screen the
  // whole dashboard — the failure mode this page hit in prod). getDailyPnl
  // is intentionally NOT awaited here anymore — the Daily P&L cell owns its
  // own fetch + Suspense below so it can stream independently.
  const statsResult = await safeQuery(
    () => getDashboardStats(DASHBOARD_CHART_PERIOD),
    null,
    "dashboard.charts",
    REWARD_QUERY_TIMEOUT_MS,
  );
  if (statsResult.error || !statsResult.data) {
    return (
      <TileErrorFallback
        label="Trends"
        hint="A metrics query failed while loading the trend charts — other sections still rendered. Refresh to retry."
        kind={statsResult.kind ?? undefined}
        size="panel"
      />
    );
  }
  const stats = statsResult.data;
  return (
    <FadeIn className="space-y-3 sm:space-y-4">
      <div className="grid gap-3 sm:gap-4 md:grid-cols-2 lg:grid-cols-3">
        <WagerChart data={stats.dailyWagers} />
        <DepositsChart data={stats.dailyDeposits} />
        <FtdsChart data={stats.dailyFtds} />
      </div>
      <div className="grid gap-3 sm:gap-4 md:grid-cols-2 lg:grid-cols-3">
        {/* Daily P&L — its own nested Suspense so the heavy getDailyPnl
            lifetime scan streams independently of the five cached-stats
            charts. Fallback is a single chart-card skeleton sized to this
            one grid cell, so the row holds its shape while P&L loads. Not
            period-keyed (getDailyPnl is period-independent), so it never
            re-suspends on a chip change. */}
        <Suspense
          fallback={<SkeletonChart height={300} className="rounded-xl" />}
        >
          <DashboardDailyPnlChart />
        </Suspense>
        <SignupsChart data={stats.dailySignups} />
        <ActiveDepositorsChart data={stats.dailyActiveDepositors} />
      </div>
    </FadeIn>
  );
}

/**
 * Daily P&L chart cell — streams behind its OWN nested Suspense inside the
 * Trends grid so its heavy lifetime-scan getDailyPnl never blocks the five
 * cached-stats charts beside it. Period-independent (lifetime), so it doesn't
 * re-key on the global period selector. safeQuery degrades a slow/failed scan
 * to a single-cell TileErrorFallback (the other charts still render).
 */
async function DashboardDailyPnlChart() {
  const { data, error, kind } = await safeQuery(
    () => getDailyPnl(),
    [],
    "dashboard.dailyPnl",
    REWARD_QUERY_TIMEOUT_MS,
  );
  if (error) {
    return (
      <TileErrorFallback
        label="Daily P&L"
        hint="The lifetime P&L scan timed out — other charts still rendered. Refresh to retry."
        kind={kind ?? undefined}
        size="panel"
      />
    );
  }
  // CQRS rollout: in `comparison` mode, run the ClickHouse daily-P&L path
  // side-by-side and LOG drift on the 30-day sums. Fire-and-forget +
  // never-throwing — the served chart below stays 100% Postgres. No-op unless
  // the flag is `comparison`.
  void compareDashboardDailyPnl(data);
  return <PnlChart data={data} />;
}

/**
 * Wager Attribution chart, hoisted into its own server component so it
 * can render alongside the Upgrader Stats panel in the 50/50 row above
 * the Trends grid. Reads from the React-cached getDashboardStats — the
 * call dedupes against the KPI strips + charts within the same render,
 * so this segment adds no extra query.
 */
async function DashboardWagerAttribution() {
  // Wrapped in safeQuery so a failing stats aggregate degrades this chart
  // (the right half of the Upgrader/Attribution row) to a fallback panel
  // instead of escaping to the route error boundary and white-screening
  // the whole dashboard.
  const { data: stats, error, kind } = await safeQuery(
    () => getDashboardStats(DASHBOARD_CHART_PERIOD),
    null,
    "dashboard.wagerAttribution",
    REWARD_QUERY_TIMEOUT_MS,
  );
  if (error || !stats) {
    return (
      <TileErrorFallback
        label="Wager Attribution"
        hint="The wager-attribution series failed to load — other sections still rendered. Refresh to retry."
        kind={kind ?? undefined}
        size="panel"
        className="h-full min-h-[400px]"
      />
    );
  }
  // The chart card is itself `h-full`, so it fills the 50/50 cell and aligns
  // with the Upgrader panel at the bottom.
  return <WagerAttributionChart data={stats.dailyWagerAttribution} />;
}

// `DashboardActivityFeed` was removed when the Recent Activity card moved
// into the docked widget (<DockedRecentActivity />) in the admin shell.
// The widget owns its own 24h count strip via `getActivityCounts24h`, so
// the dashboard page no longer needs a server-side wrapper for it.
