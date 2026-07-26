import { Suspense } from "react";
import { LayoutDashboard, LineChart } from "lucide-react";
import { getDashboardStats } from "@/lib/queries/dashboard";
import { getUpgraderStats } from "@/lib/queries/dashboard-upgrader";
import { getDoubleDownDashboardStats } from "@/lib/queries/double-down";
import { getDailyPnl } from "@/lib/queries/pnl";
import { getDailyCreatorCost } from "@/lib/queries/dashboard-daily-creator-cost";
import { getTodayPnl } from "@/lib/queries/dashboard-today-pnl";
import { getRewardCostsToday } from "@/lib/queries/dashboard-reward-costs-today";
import { getRakebackFromTodayWager } from "@/lib/queries/dashboard-rakeback-same-day";
import { getCreatorCostsToday } from "@/lib/queries/dashboard-creator-costs-today";
import { getAffiliateReferredPnlToday } from "@/lib/queries/dashboard-affiliate-referred-pnl-today";
import { getCryptoFeeProfitCounter } from "@/lib/queries/dashboard-crypto-fee-counter";
import { requirePageAccess } from "@/lib/dal";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import {
  DashboardKpiSection,
  type CryptoFeeKpi,
} from "./dashboard-kpi-section";
import { buildKpiWindowPayload } from "./kpi-window-data";
import { TodayPnlStatCard } from "./today-pnl-stat-card";
import { RewardCreatorCostsTodayCard } from "./reward-creator-costs-today-card";
import { UpgraderDoubleDownTodayCard } from "./upgrader-double-down-today-card";
import { AutoRefresh } from "./auto-refresh";
import {
  WagerChart,
  WagerAttributionChart,
  DepositsChart,
  SignupsChart,
  CashPnlChart,
  ActiveDepositorsChart,
} from "./charts";
import { PageHero, PageHeroIdentity, SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import {
  SkeletonKpiStrip,
  SkeletonChart,
} from "@/components/ux";
import {
  ChartRowSkeleton,
  TodayTileSkeleton,
} from "./dashboard-skeletons";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  await requirePageAccess("/dashboard");

  // Trend charts + Wager Attribution are ALWAYS 30-day daily buckets (fixed).
  // The headline KPI boxes are independent — they default to "today" (since
  // 00:00 UTC) via buildKpiWindowPayload and carry their own per-box today/24h
  // toggle, fetching the 24h window lazily on first toggle.

  return (
    <div className="space-y-6">
      {/* Dashboard polls at 60s for KPI and chart data. */}
      <AutoRefresh intervalMs={60_000} />

      <PageHero>
        <PageHeroIdentity
          icon={LayoutDashboard}
          title="Dashboard"
          subtitle="Live platform overview — revenue, users, and trends."
        />
      </PageHero>

      {/* TODAY BOXES — P&L Today · Reward + Creators Costs (merged) ·
          Upgrader + Double Down (merged), in that order, at the top.
          P&L Today and Reward + Creators Costs use the CURRENT CALENDAR DAY
          since 00:00 UTC (NOT a rolling past-24h window) and share the same
          UTC-midnight boundary. Upgrader + Double Down are LIFETIME
          aggregates (period-independent) — they moved up into this row from
          the old 50/50 panel row below the KPI strip (owner request,
          2026-07-02: merge the two panels into one box "like deposits /
          withdrawals" and drop it into the slot the standalone Creators
          Costs card used to occupy, now that Creators Costs merged into the
          Reward Costs card). Each of the three streams behind its OWN
          Suspense + safeQuery. Full-width on mobile, 2-up at sm, 3-up at
          xl. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-3">
        <Suspense fallback={<TodayTileSkeleton />}>
          <DashboardTodayPnl />
        </Suspense>
        <Suspense fallback={<TodayTileSkeleton />}>
          <DashboardRewardAndCreatorCostsToday />
        </Suspense>
        <Suspense fallback={<TodayTileSkeleton />}>
          <DashboardUpgraderDoubleDownToday />
        </Suspense>
      </div>

      {/* KPI boxes — Wager [Total + Organic merged], Deposits/Withdrawals
          [merged], the anchored Crypto Fee counter, and Keno performance.
          The period-bound boxes carry their own today/24h toggle. GGR MOVED
          into the "P&L Today" tile above (owner request, 2026-07-02: that
          tile had empty space once its siblings grew back their full data
          sets) —
          Keno now fills the fourth box with wager, payouts, realized edge,
          and profit. DEFAULTS to "today" (loaded eagerly
          here); the rolling 24h window is fetched lazily on the first
          toggle inside the client section (active-timeframe-only).

          The window-independent snapshot boxes (FTDs, Depositors, Avg RTP, Avg
          P&L 7d, Total P&L lifetime) MOVED to the owner-only lifetime section
          on `/analytics` (Overview tab) — the dashboard is a live-ops board,
          the lifetime / cadence aggregates live there. Total P&L + Avg P&L
          were folded into a single box in that section.

          NOT keyed on any global selector — these boxes own their own today/24h
          window via the toggle next to each title. Streams behind its own Suspense
          so the today-window aggregate never blocks the 3 cost cards above;
          the skeleton mirrors the single 4-up period strip. */}
      <Suspense
        fallback={
          <SkeletonKpiStrip
            count={4}
            className="sm:grid-cols-2 md:grid-cols-2 xl:grid-cols-4"
          />
        }
      >
        <DashboardKpiBoxes />
      </Suspense>

      {/* Charts. Three-up at lg+ but stacks to a single column on
          phones so each chart keeps a readable height (Recharts crushes
          when forced into a tight grid cell). At md we go 2-up so the
          row stays balanced before we have room for the third. Wager
          Attribution used to live in a 50/50 row next to Upgrader Stats
          (that row is gone — both panels merged into the
          `UpgraderDoubleDownTodayCard` Today-row tile); Wager Attribution
          now fills the slot the removed Daily P&L chart used to occupy
          here, so Trends is two 3-up rows. */}
      <div className="space-y-3">
        <SectionHeading icon={LineChart} title="Trends" />
        {/* Row 1 (3-up): Wagers · Deposits · Signups & FTDs (merged).
            Row 2 (3-up): Daily P&L · Daily Cash P&L · Active Depositors.

            Signups and FTDs share one card so the funnel reads in one
            place — the merge happens at the page level (dailySignups +
            dailyFtds joined by date), so neither query changes shape.
            With the FTDs card folded into Signups the Trends grid is
            two clean 3-up rows: customer-acquisition / volume on top,
            money + retention on the bottom.

            The four cached-stats charts (everything EXCEPT the two P&L
            charts) are backed by the React-cached getDashboardStats —
            which the KPI strips already triggered — so this outer
            boundary resolves as soon as that shared aggregate is ready
            and paints them together. The two P&L charts share the heavy
            getDailyPnl leg, streamed behind a nested <Suspense> in row 2
            so neither blocks the cached row(s); the Suspense returns a
            2-cell fragment, so both P&L charts paint side-by-side once
            the lifetime scan resolves, and Active Depositors (a cached
            chart) renders immediately as the third cell of row 2.

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

    </div>
  );
}

/** Fixed period for trend charts — always 30-day daily buckets. */
const DASHBOARD_CHART_PERIOD = "30d" as const;

/**
 * Eager-renders the dashboard's period-bound KPI boxes for the DEFAULT "today"
 * window (since 00:00 UTC) and hands the client section the today payload +
 * the anchored Crypto Fee counter. The payload also contains settled Keno
 * performance for the active window. The client section adds the per-box
 * today/24h toggle and fetches the rolling-24h payload lazily on the first
 * toggle (active-timeframe-only — the 24h aggregate never runs here).
 *
 * The window-independent snapshot boxes (FTDs, Depositors, Avg RTP, Avg P&L
 * 7d, Total P&L lifetime) that used to live here MOVED to the owner-only
 * lifetime section on `/analytics` (Overview tab), so this component no
 * longer reads `getDashboardKpiStats` / `getAvgPnl7d` /
 * `getRealizedPnlSnapshot` — the dashboard is now a live-ops board only.
 *
 * Wrapped in safeQuery so a failing today-window aggregate degrades to a
 * single panel fallback instead of escaping to the route error boundary
 * (which would white-screen the whole dashboard — the failure mode this
 * page hit in prod).
 */
async function DashboardKpiBoxes() {
  const [payloadResult, cryptoFeeResult] = await Promise.all([
    // Period-bound box values + GGR legs for the eager "today" window.
    safeQuery(
      () => buildKpiWindowPayload("today"),
      null,
      "dashboard.kpiToday",
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
  if (payloadResult.error || !payloadResult.data) {
    return (
      <TileErrorFallback
        label="Platform KPIs"
        hint="A metrics query failed while loading the KPI boxes — other sections still rendered. Refresh to retry."
        kind={payloadResult.kind ?? undefined}
        size="panel"
      />
    );
  }
  const today = payloadResult.data;

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

  return <DashboardKpiSection today={today} cryptoFee={cryptoFee} />;
}

/**
 * Upgrader + Double Down — MERGED Today-row tile (owner request,
 * 2026-07-02: merge the two lifetime game-type panels into one box "like
 * deposits / withdrawals" and move it into the Today boxes row, in the slot
 * the standalone Creators Costs card used to occupy). Both stats are their
 * own standalone lifetime-aggregate queries (getUpgraderStats /
 * getDoubleDownDashboardStats), fetched in parallel so neither scan blocks
 * the other or the headline KPIs. Both are period-independent, so this tile
 * never re-suspends on a chip click — its skeleton only shows on the cold
 * load. Either query failing degrades the WHOLE tile to a fallback (a
 * half-rendered merged card would look broken) instead of crashing the
 * route.
 */
async function DashboardUpgraderDoubleDownToday() {
  const [upgraderResult, doubleDownResult] = await Promise.all([
    // getUpgraderStats is already to_regclass-guarded (it returns zeroed
    // stats on a pre-upgrader DB rather than throwing 42P01), but wrap it in
    // safeQuery anyway so ANY other failure (a slow scan, a connection blip)
    // degrades this tile to a fallback instead of crashing the route.
    safeQuery(
      () => getUpgraderStats(),
      null,
      "dashboard.upgrader",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    // Double Down — lifetime aggregate over the battle_double_down game-type
    // (DEV's canonical game_sessions JOIN), 5-min cached + to_regclass guarded.
    safeQuery(
      () => getDoubleDownDashboardStats(),
      null,
      "dashboard.doubleDown",
      REWARD_QUERY_TIMEOUT_MS,
    ),
  ]);
  if (
    upgraderResult.error ||
    !upgraderResult.data ||
    doubleDownResult.error ||
    !doubleDownResult.data
  ) {
    return (
      <TileErrorFallback
        label="Upgrader + Double Down"
        hint="A game-type aggregate failed to load — other sections still rendered. Refresh to retry."
        kind={upgraderResult.kind ?? doubleDownResult.kind ?? undefined}
        size="compact"
      />
    );
  }
  const stats = upgraderResult.data;
  // side-by-side and LOG drift. Fire-and-forget + never-throwing — the served
  // tile below stays 100% Postgres. No-op unless the flag is `comparison`.
  return (
    <UpgraderDoubleDownTodayCard
      upgrader={{
        pnl: stats.pnl,
        edge: stats.edge,
        wager: stats.wager,
        payouts: stats.payouts,
        bets: stats.bets,
        avgBet: stats.avgBet,
        uniquePlayers: stats.uniquePlayers,
        hitRate: stats.hitRate,
      }}
      doubleDown={{
        netHousePnl: doubleDownResult.data.netHousePnl,
        winRate: doubleDownResult.data.winRate,
        rounds: doubleDownResult.data.rounds,
        staked: doubleDownResult.data.staked,
      }}
    />
  );
}

/**
 * P&L Today tile — house P&L for the current calendar day since 00:00
 * UTC (NOT a rolling past-24h window). Its own standalone query
 * (getTodayPnl, cached 60s + keyed on the UTC day boundary), wrapped in
 * safeQuery so a slow today-window scan degrades to a tile fallback
 * instead of crashing the dashboard. The query reuses the canonical
 * windowed-delta P&L formula (calculateWindowedPnl), so this reconciles
 * with the period-P&L card + daily-P&L chart.
 *
 * Also fetches the "today" GGR payload (owner request, 2026-07-02: fill the
 * P&L Today tile's empty space with GGR at the bottom, P&L stays at the
 * top) via the SAME `buildKpiWindowPayload("today")` the KPI strip's own
 * `DashboardKpiBoxes()` calls — `getDashboardKpiStats` is React
 * `cache()`-wrapped and the GGR legs are `unstable_cache`-backed, so this
 * second call dedupes/hits cache rather than re-running the heavy
 * aggregate. Runs in its own `safeQuery` so a failed GGR fetch only omits
 * that section instead of taking the whole P&L tile down.
 */
async function DashboardTodayPnl() {
  const [{ data, error, kind }, ggrResult] = await Promise.all([
    safeQuery(
      () => getTodayPnl(),
      null,
      "dashboard.todayPnl",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => buildKpiWindowPayload("today"),
      null,
      "dashboard.todayPnlGgr",
      REWARD_QUERY_TIMEOUT_MS,
    ),
  ]);
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
  const ggrPayload = ggrResult.data;
  // side-by-side and LOG drift. Fire-and-forget + never-throwing — the served
  // tile below stays 100% Postgres. No-op unless the flag is `comparison`.
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
      ggr={
        ggrPayload
          ? {
              value: ggrPayload.ggr,
              cashGgr: ggrPayload.cashGgr,
              deposits: ggrPayload.deposits,
              withdrawals: ggrPayload.withdrawals,
              breakdown: ggrPayload.ggrBreakdown,
            }
          : null
      }
    />
  );
}

/**
 * Reward + Creators Costs Today tile — MERGED (owner request, 2026-07-02:
 * "move reward cost and creators costs into one box like deposits /
 * withdrawals"). Both legs cover the current calendar day since 00:00 UTC
 * (NOT a rolling past-24h window), share the same UTC-midnight boundary, and
 * run as three independent queries in parallel:
 *   • getRewardCostsToday          — reward/retention spend (REWARD_PAYOUT_TYPES
 *     + manual-voucher / counted-adjustment carve-outs + daily-pack giveaway,
 *     rain as the owner-confirmed flat $2/hr model, affiliate excluded).
 *   • getCreatorCostsToday         — creator-activity spend (Creator Deal
 *     Payouts, both legs of tips-sponsor-spend, full leaderboard gross,
 *     affiliate_claim commissions moved wholesale from Reward Costs).
 *   • getAffiliateReferredPnlToday — an INDEPENDENT corner indicator (house
 *     P&L on affiliate-referred players); a failing/slow scan only drops the
 *     small badge (passed as null), it never takes the merged tile down.
 * Reward Costs and Creators Costs failing/degrading DOES take the whole tile
 * down to a fallback — a half-rendered merged card would look broken.
 */
async function DashboardRewardAndCreatorCostsToday() {
  const [rewardResult, creatorsResult, pnlResult, rakebackSameDayResult] = await Promise.all([
    safeQuery(
      () => getRewardCostsToday(),
      null,
      "dashboard.rewardCostsToday",
      REWARD_QUERY_TIMEOUT_MS,
    ),
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
    // Independent overlay figure for the "Rakeback claims" chip — a failed/
    // slow scan only drops the sub-line (passed as null), it never takes
    // the merged tile down (same posture as the affiliate-referred P&L
    // corner indicator above).
    safeQuery(
      () => getRakebackFromTodayWager(),
      null,
      "dashboard.rakebackFromTodayWager",
      REWARD_QUERY_TIMEOUT_MS,
    ),
  ]);
  if (
    rewardResult.error ||
    !rewardResult.data ||
    creatorsResult.error ||
    !creatorsResult.data
  ) {
    return (
      <TileErrorFallback
        label="Reward + Creators Costs"
        hint="A today-window cost scan timed out — refresh to retry."
        kind={rewardResult.kind ?? creatorsResult.kind ?? undefined}
        size="compact"
      />
    );
  }
  const reward = rewardResult.data;
  const creators = creatorsResult.data;
  // and LOG drift. Fire-and-forget + never-throwing — the served tile below
  // stays 100% Postgres. No-op unless each flag is `comparison`. The non-DB
  // rain line ($2/hr) has no DB source and is EXCLUDED from the reward-cost
  // comparison (the CH twin compares the DB sub-total = total − rainCost).
  // dayStartIso is "YYYY-MM-DDT00:00:00.000Z"; the YYYY-MM-DD slice is the
  // UTC calendar day this cost covers (matches the window boundary exactly,
  // identical on both legs since they share the same "today" boundary).
  const dayLabel = reward.dayStartIso.slice(0, 10);
  return (
    <RewardCreatorCostsTodayCard
      reward={{
        total: reward.total,
        lines: reward.lines,
        dayLabel,
        hoursElapsed: reward.hoursElapsed,
        rakebackFromTodayWager: rakebackSameDayResult.data ?? null,
      }}
      creators={{
        total: creators.total,
        lines: creators.lines,
        dayLabel,
        // Aggregate house P&L on affiliate-referred players for the same
        // "today" window — null when the scan failed/degraded (badge then
        // omitted).
        affiliateReferredPnl: pnlResult.data?.pnl ?? null,
      }}
    />
  );
}

/**
 * Trend charts in two 3-up rows:
 *   Row 1: Wagers · Deposits · Signups & FTDs (merged) — cached getDashboardStats
 *   Row 2: Wager Attribution · Daily Cash P&L (merged) · Active Depositors
 *
 * The cached-stats charts (Wagers, Deposits, Signups&FTDs, Wager Attribution,
 * Active Depositors) read from the React-cached getDashboardStats the KPI
 * strips already triggered — so this component awaits ONLY that (the call
 * dedupes; it's effectively free here) and paints them as soon as it's
 * ready. Daily Cash P&L derives from the one heavy lifetime-scan
 * getDailyPnl, so it streams behind its own nested <Suspense>
 * (DashboardCashPnlChart) inside row 2's grid — the slow scan can't hold
 * back the cached charts beside it. The former standalone "Daily P&L" chart
 * was removed and its canonical breakdown merged into Daily Cash P&L's hover
 * (see `CashPnlChart` / `CashPnlTooltip` in `charts.tsx`) — the bars
 * themselves stay deposits − withdrawals only.
 *
 * Wager Attribution used to live in a 50/50 row next to Upgrader Stats; it
 * now fills the slot the removed Daily P&L chart occupied here.
 */
async function DashboardCharts() {
  // getDashboardStats backs the wager/deposit/ftds/signup/attribution/
  // depositor charts. Always 30-day daily buckets — NOT tied to any global
  // period selector. Wrapped in safeQuery so a throw degrades to a fallback
  // instead of escaping to the route error boundary (which would
  // white-screen the whole dashboard — the failure mode this page hit in
  // prod). getDailyPnl is intentionally NOT awaited here — the Cash P&L cell
  // owns its own fetch + Suspense below so it can stream independently.
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
  // Merge the signups + FTD series for the combined Signups & FTDs chart.
  // Both arrays come back date-padded by the dashboard chart helpers
  // (`padDashboardCountSeries` / `padDashboardFtdSeries`) so missing days are
  // zero-filled on either side and the union of dates is the same on both —
  // a Map keyed by date is the safe join (handles any future ordering drift).
  const ftdByDate = new Map(stats.dailyFtds.map((d) => [d.date, d]));
  const signupsAndFtdsSeries = stats.dailySignups.map((s) => {
    const f = ftdByDate.get(s.date);
    return {
      date: s.date,
      signups: s.count,
      ftds: f?.count ?? 0,
      ftdTotal: f?.total ?? 0,
      ftdAvg: f?.avg ?? 0,
    };
  });
  return (
    <FadeIn className="space-y-3 sm:space-y-4">
      <div className="grid gap-3 sm:gap-4 md:grid-cols-2 lg:grid-cols-3">
        <WagerChart data={stats.dailyWagers} />
        <DepositsChart data={stats.dailyDeposits} />
        <SignupsChart data={signupsAndFtdsSeries} />
      </div>
      <div className="grid gap-3 sm:gap-4 md:grid-cols-2 lg:grid-cols-3">
        {/* Wager Attribution — cached-stats, paints immediately without
            waiting on the Cash P&L lifetime scan beside it. */}
        <WagerAttributionChart data={stats.dailyWagerAttribution} />
        {/* Daily Cash P&L — its own nested Suspense so the heavy
            getDailyPnl lifetime scan streams independently of the
            cached-stats charts beside it. Not period-keyed (getDailyPnl is
            period-independent), so it doesn't re-suspend on a chip change. */}
        <Suspense
          fallback={<SkeletonChart height={300} className="rounded-xl" />}
        >
          <DashboardCashPnlChart />
        </Suspense>
        <ActiveDepositorsChart data={stats.dailyActiveDepositors} />
      </div>
    </FadeIn>
  );
}

/**
 * Daily Cash P&L chart cell — streams behind its OWN nested Suspense inside
 * the Trends grid so its heavy lifetime-scan getDailyPnl never blocks the
 * cached-stats charts beside it. Period-independent (lifetime), so it
 * doesn't re-key on the global period selector. safeQuery degrades a
 * slow/failed scan to a single-cell TileErrorFallback (the other charts
 * still render).
 *
 * The bars stay deposits − withdrawals only (cash flow); the FULL canonical
 * house-P&L breakdown that used to be its own "Daily P&L" chart is merged
 * into this chart's hover instead (see `CashPnlChart` / `CashPnlTooltip` in
 * `charts.tsx`) — no separate chart, no extra query.
 */
async function DashboardCashPnlChart() {
  // P&L (for the merged hover breakdown) and the informational per-day
  // creator cost (also hover-only) are independent reads — fetch them in
  // parallel. Creator cost is a SEPARATE series merged here at the page
  // level; it never touches DailyPnlPoint or the dashboard_daily_pnl
  // summed into the P&L total.
  const [
    { data, error, kind },
    { data: creatorCostPoints },
  ] = await Promise.all([
    safeQuery(() => getDailyPnl(), [], "dashboard.dailyPnl", REWARD_QUERY_TIMEOUT_MS),
    safeQuery(
      () => getDailyCreatorCost(),
      [],
      "dashboard.dailyCreatorCost",
      REWARD_QUERY_TIMEOUT_MS,
    ),
  ]);
  if (error) {
    return (
      <TileErrorFallback
        label="Daily Cash P&L"
        hint="The lifetime P&L scan timed out — other charts still rendered. Refresh to retry."
        kind={kind ?? undefined}
        size="panel"
      />
    );
  }
  // resolved inside getDailyPnl via resolveAdminRead("dashboard_daily_pnl"),
  // which also fires the comparison-mode drift log — so no page-level compare
  // call is needed here (it would double-log in comparison mode).
  const creatorCostByDate = new Map(
    creatorCostPoints.map((p) => [p.date, p.creatorCost]),
  );
  // Cash P&L = deposits − withdrawals per day (raw crypto cash flow only —
  // same canonical formula as the "P&L Today" tile's `rawCashPnl`). The bars
  // use this; the rest of each row (pnl, balanceChange, inventoryChange,
  // voucherChange, creatorCost) rides along for the merged hover breakdown.
  const cash = data.map((d) => ({
    date: d.date,
    deposits: d.deposits,
    withdrawals: d.withdrawals,
    cashPnl: d.deposits - d.withdrawals,
    pnl: d.pnl,
    balanceChange: d.balanceChange,
    inventoryChange: d.inventoryChange,
    voucherChange: d.voucherChange,
    creatorCost: creatorCostByDate.get(d.date) ?? 0,
  }));
  return <CashPnlChart data={cash} />;
}
