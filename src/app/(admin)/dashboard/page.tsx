import { Suspense } from "react";
import {
  Users,
  Percent,
  Coins,
  LayoutDashboard,
  LineChart,
  BadgeDollarSign,
  HandCoins,
  Gauge,
} from "lucide-react";
import {
  getDashboardStats,
  getActiveRain,
  getGgrBreakdown,
  parseDashboardPeriod,
  type DashboardPeriod,
} from "@/lib/queries/dashboard";
import { DashboardPeriodSelector } from "./dashboard-period-selector";
import { getUpgraderStats } from "@/lib/queries/dashboard-upgrader";
import { getDailyPnl } from "@/lib/queries/pnl";
import { getTodayPnl } from "@/lib/queries/dashboard-today-pnl";
import { getRewardCostsToday } from "@/lib/queries/dashboard-reward-costs-today";
import { getCreatorCostsToday } from "@/lib/queries/dashboard-creator-costs-today";
import { requirePageAccess } from "@/lib/dal";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import { LoadTimeIndicator } from "./load-time-indicator";
import { StatCard } from "./stat-card";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import {
  PnlStatCard,
  GgrStatCard,
  WagerStatCard,
  DepositsStatCard,
  WithdrawalsStatCard,
} from "./revenue-stat-card";
import { TodayPnlStatCard } from "./today-pnl-stat-card";
import { RewardCostsTodayCard } from "./reward-costs-today-card";
import { CreatorCostsTodayCard } from "./creator-costs-today-card";
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

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/dashboard");

  // The page's heavy aggregates (revenue / wager / GGR / windowed P&L)
  // run for the SELECTED period only — sub-hour / day / lifetime windows
  // are computed on demand when the admin picks a chip in the global
  // <DashboardPeriodSelector>. Default falls back to 24h when the URL
  // carries no `?period=` so a cold load still has a sensible window.
  // getDashboardStats is React-cached and keyed on `period`, so the
  // four Suspense segments below share a single fetch per render.
  const params = await searchParams;
  const period: DashboardPeriod = parseDashboardPeriod(params.period);

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
    <div className="space-y-6 pr-10 xl:pr-12 2xl:pr-16">
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
          // the load-time indicator, each behind its own tiny Suspense so
          // the hero paints instantly. Wrap so they sit side by side and
          // wrap onto a second line on narrow phones.
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
                <DashboardLoadTime period={period} />
              </Suspense>
            </div>
          }
        />
      </PageHero>

      {/* Global period selector. Drives the `?period=` URL param;
          every period-bound KPI / aggregate on the page reads from
          that. Client component — server cards don't re-render when a
          chip is hovered, only when it's clicked (router.replace). */}
      <DashboardPeriodSelector />

      {/* Primary + secondary KPI strips stream together — they share the
          same getDashboardStats fetch, so splitting them into separate
          boundaries would just show two skeletons resolving at the same
          instant. Fallback mirrors the 6-up primary + 7-up secondary
          grids in DashboardStatStrips.

          No period-keyed Suspense here: keying on `period` would tear the
          resolved strips down and re-show the skeleton on every chip click.
          Instead the period selector flips the URL inside a useTransition,
          so React keeps the PREVIOUS strips on screen while the next
          payload streams (the selector shows the pending state). The
          skeleton is reserved for the genuine cold load (loading.tsx /
          first mount), where there's nothing to keep. */}
      <Suspense
        fallback={
          <>
            <SkeletonKpiStrip count={6} />
            <SkeletonKpiStrip count={7} />
          </>
        }
      >
        <DashboardStatStrips period={period} />
      </Suspense>

      {/* Today-since-00:00 tiles — P&L Today + Reward Costs Today +
          Creators Costs Today. All three are house figures for the CURRENT
          CALENDAR DAY since 00:00 UTC (NOT a rolling past-24h window) and
          share the same UTC-midnight boundary, so they reconcile. Each
          streams behind its OWN Suspense + safeQuery so its today-window
          scan never blocks the period KPI strips above and degrades to a
          tile fallback if it's slow. Period-independent (always "today"), so
          none re-keys on the global period selector. Full-width-on-mobile,
          2-up at sm, 3-up at lg+ — exactly matches the 3 children below so
          there's no dead column on the right at lg+. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
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
      </div>

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
        {/* Wager Attribution IS period-bound, but we intentionally DON'T key
            it on `period` — keeping the prior chart on screen during a
            refetch (driven by the selector's transition) reads far better
            than blanking it back to a skeleton on every chip change. The
            chart skeleton is matched to the card chrome + height for the
            cold load. */}
        <Suspense
          fallback={
            <SkeletonChart
              height={400}
              className="h-full min-h-[400px] rounded-xl"
            />
          }
        >
          <DashboardWagerAttribution period={period} />
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
            Single Suspense — the row-1/2 charts share the cached
            getDashboardStats and the standalone getDailyPnl runs in
            parallel with it.

            Not period-keyed: the trend charts stay on screen during a
            period refetch (the selector's transition keeps the prior
            render) rather than flashing two rows of skeletons on each
            chip change. The skeleton is for the cold load only and now
            mirrors the chart-card chrome (rounded-xl, faux bars) so it
            doesn't pop a flat block into a chart. */}
        <Suspense
          fallback={
            <>
              <ChartRowSkeleton count={3} height={300} />
              <ChartRowSkeleton count={3} height={300} />
            </>
          }
        >
          <DashboardCharts period={period} />
        </Suspense>
      </div>

      {/* Recent Activity moved into the admin shell as the middle
          docked widget (<DockedRecentActivity />) so every admin page
          gets the same live event feed on the right edge. The
          dashboard body no longer renders the in-page card. */}

    </div>
  );
}

/**
 * Load-time chip for the hero action slot. Streams behind its own tiny
 * Suspense; reads the same React-cached getDashboardStats, so it adds no
 * extra query — it just surfaces the queryMs / generatedAt that the
 * aggregate already measures.
 */
async function DashboardLoadTime({ period }: { period: DashboardPeriod }) {
  // Wrapped in safeQuery so a failing/slow stats aggregate degrades this
  // hero chip to nothing instead of throwing up the route boundary (the
  // chip is decorative — a missing load-time indicator must never take
  // the page down). The KPI strip surfaces the same failure as a tile
  // fallback, so the operator still sees the degraded state there.
  const { data: stats, error } = await safeQuery(
    () => getDashboardStats(period),
    null,
    "dashboard.loadTime",
  );
  if (error || !stats) return null;
  return (
    <LoadTimeIndicator
      queryMs={stats.queryMs}
      generatedAt={stats.generatedAt}
      // Formatted server-side so the first client paint is byte-identical to
      // the SSR markup (no #418); the client re-derives it after mount.
      initialRelative={formatRelative(stats.generatedAt)}
    />
  );
}

/**
 * Primary (period-aware) + secondary (snapshot) KPI strips. Async so it
 * streams behind the page-level Suspense; reads the React-cached
 * getDashboardStats. Also pulls the per-type GGR breakdown (cached
 * separately with the same period+blacklist key) so the GgrStatCard's
 * Info popover can render auditable wager/payout components without
 * a second roundtrip on first paint.
 */
async function DashboardStatStrips({ period }: { period: DashboardPeriod }) {
  // Each leg is wrapped in safeQuery so a throw degrades to a fallback
  // tile instead of escaping to the route error boundary (which would
  // white-screen the WHOLE dashboard — the failure mode this page hit in
  // prod). getDashboardStats backs every tile in both strips, so if IT
  // fails the strips degrade to a single panel fallback. getGgrBreakdown
  // only feeds the GGR card's Info popover, so if only it fails we keep
  // the strips and render the GGR card with an empty breakdown.
  const [statsResult, ggrResult] = await Promise.all([
    safeQuery(() => getDashboardStats(period), null, "dashboard.statStrips"),
    safeQuery(() => getGgrBreakdown(period), null, "dashboard.ggrBreakdown"),
  ]);
  if (statsResult.error || !statsResult.data) {
    return (
      <TileErrorFallback
        label="Platform KPIs"
        hint="A metrics query failed while loading the KPI strips — other sections still rendered. Refresh to retry."
        size="panel"
      />
    );
  }
  const stats = statsResult.data;
  // Empty-but-valid breakdown when only the popover query failed, so the
  // GgrStatCard still renders its headline number (the popover just shows
  // zeroed legs). Shape matches GgrBreakdown.
  const ggrBreakdown = ggrResult.data ?? {
    wagers: [],
    payouts: [],
    wagersTotal: 0,
    payoutsTotal: 0,
    ggr: 0,
  };

  // Average deposit transactions per hour. depositCount24h / depositCount7d
  // are FIXED windows (not period-bound) so the tile's "last 24h avg ·
  // 7d baseline" semantic stays stable when the global selector
  // changes — flipping the chip shouldn't reshape a tile that's
  // explicitly labelled 24h / 7d.
  const depositsPerHour24h = stats.depositCount24h / 24;
  const depositsPerHour7d = stats.depositCount7d / (7 * 24);

  return (
    <>
      {/* Primary stats — period-aware cards.
          Mobile-first grid: ONE column at <sm so each card is full-
          width and the dollar value never truncates (these cards
          contain a 5-chip period selector + a hero currency value;
          squeezing 2-up at 380px crushed both). 2-up at sm, 4 at lg,
          6 across at xl (PnL, GGR, Wager, Organic Wager, Deposits,
          Withdrawals). The previous "Raw Wager"
          tile (creator-on-stream sponsored wager INCLUDED) was
          dropped — it only made sense alongside the customer-only
          "Total Wager" to show the gap, and admins didn't act on it.
          The surviving Wager tile is the customer-only figure
          (creator sessions excluded), which is the default reading
          of "wager" everywhere else on the site. */}
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4 xl:grid-cols-6">
        <PnlStatCard
          pnl={stats.realizedPnl}
          pnlPeriod={stats.realizedPnlPeriod}
          periodLabel={stats.periodLabel}
        />
        <GgrStatCard
          ggr={stats.ggr}
          periodLabel={stats.periodLabel}
          breakdown={ggrBreakdown}
          periodParam={period}
        />
        {/* Wager — customer wager only (drops wagers a creator made
            while live on a deal/stream — house-funded sponsored
            balance, not a real customer bet). This IS the default
            "wager" reading on the rest of the site, so it doesn't
            need a disambiguating caption. */}
        <WagerStatCard
          wager={stats.wagers}
          periodLabel={stats.periodLabel}
          title="Wager"
          breakdown={stats.wagersBreakdown}
        />
        {/* Organic Wager — only counts users who did NOT join under an
            official creator code. Drops creator-on-stream play AND
            creator-attributed customer wager, so the gap between
            "Wager" and this card is the wager that's downstream of
            creator marketing. */}
        <WagerStatCard
          wager={stats.wagersOrganic}
          periodLabel={stats.periodLabel}
          title="Organic Wager"
          caption="no creator-code users"
        />
        <DepositsStatCard
          deposits={stats.deposits}
          depositCount={stats.depositCountPeriod}
          periodLabel={stats.periodLabel}
        />
        <WithdrawalsStatCard
          withdrawals={stats.withdrawals}
          withdrawalCount={stats.withdrawalCountPeriod}
          periodLabel={stats.periodLabel}
        />
      </div>

      {/* Secondary stats — all-time / snapshot. Users Total Balance
          (user-held cash + unsold inventory + unclaimed vouchers) was
          dropped from this row — the figure is a HOUSE LIABILITY that
          tells you what you owe out, but operators rarely act on it
          and the underlying query (full-table user_inventory scan)
          was one of the heaviest on the dashboard. The realized P&L
          snapshot still factors all three into the lifetime PnL tile,
          so the information isn't gone — just folded into PnL. */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 sm:gap-4 lg:grid-cols-6">
        <StatCard
          title="Total Users"
          animatedValue={stats.users.total}
          formatKind="number"
          subtitle={`+${stats.users.today} today, +${stats.users.week} this week`}
          icon={Users}
          color="blue"
        />
        {/* FTDs — first-time depositors in the rolling last 24h: real
            users whose first-ever completed deposit landed today. The
            "new money today" lead-in to the lifetime Depositors tile.
            Subtitle carries the summed + average first-deposit value.
            Amber accent — its own identity color, warm against the
            cool-toned Total Users / Depositors neighbours. */}
        <StatCard
          title="FTDs (24h)"
          animatedValue={stats.financials.ftds24h}
          formatKind="number"
          subtitle={`${formatCurrency(stats.financials.ftdTotal24h)} total · ${formatCurrency(stats.financials.ftdAvg24h)} avg`}
          icon={HandCoins}
          color="amber"
        />
        {/* Distinct depositors = how many real users have completed at
            least one deposit. Different from "Total Users" (signups,
            many of whom never deposit) and from "Avg Deposit" (per-
            transaction). Uses purple to read as a separate identity
            from the user-count tile. */}
        <StatCard
          title="Depositors"
          animatedValue={stats.financials.uniqueDepositors}
          formatKind="number"
          subtitle={
            stats.users.total > 0
              ? `${(
                  (stats.financials.uniqueDepositors / stats.users.total) *
                  100
                ).toFixed(1)}% of users have funded`
              : "Unique players who funded at least once"
          }
          icon={BadgeDollarSign}
          color="purple"
        />
        {/* Avg Deposit is an inflow stat. Using cyan here so each secondary
            card has its own identity color. */}
        <StatCard
          title="Avg Deposit"
          animatedValue={stats.financials.avgDeposit}
          formatKind="currency"
          subtitle="Across all users (lifetime)"
          icon={Coins}
          color="cyan"
        />
        {/* Deposits / Hour — average deposit transactions per hour.
            Hero is the last-24h rate (count ÷ 24); subtitle carries the
            7-day baseline. Emerald = money flowing in (house POV), to
            match the Deposits card. Uses `value` (not animatedValue)
            because AnimatedNumber rounds the "number" format to an
            integer and we want the .1 precision on a fractional rate. */}
        <StatCard
          title="Deposits / Hour"
          value={depositsPerHour24h.toFixed(1)}
          subtitle={`last 24h avg · 7d ${depositsPerHour7d.toFixed(1)}/hr`}
          icon={Gauge}
          color="emerald"
        />
        {/* The "Creator Deal Payouts (withdrawn)" tile that used to sit here
            (next to Deposits / Hour) was removed — the new "Creators Costs
            (today)" box above (next to Reward Costs) now covers creator
            spend, including creator deal-payout withdrawals. */}
        <StatCard
          title="Avg RTP"
          animatedValue={
            stats.financials.totalWagered > 0
              ? (stats.financials.totalWon / stats.financials.totalWagered) *
                100
              : 0
          }
          formatKind="percent"
          icon={Percent}
          color="pink"
        />
      </div>
    </>
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
  const { data: stats, error } = await safeQuery(
    () => getUpgraderStats(),
    null,
    "dashboard.upgrader",
  );
  if (error || !stats) {
    return (
      <TileErrorFallback
        label="Upgrader Stats"
        hint="The upgrader aggregate failed to load — other sections still rendered. Refresh to retry."
        size="panel"
        className="h-full min-h-[400px]"
      />
    );
  }
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
  const { data, error } = await safeQuery(
    () => getTodayPnl(),
    null,
    "dashboard.todayPnl",
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="P&L Today"
        hint="The today-window P&L scan timed out — refresh to retry."
        size="compact"
      />
    );
  }
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
  const { data, error } = await safeQuery(
    () => getRewardCostsToday(),
    null,
    "dashboard.rewardCostsToday",
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Reward Costs"
        hint="The today-window reward-cost scan timed out — refresh to retry."
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
  const { data, error } = await safeQuery(
    () => getCreatorCostsToday(),
    null,
    "dashboard.creatorCostsToday",
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Creators Costs"
        hint="The today-window creator-cost scan timed out — refresh to retry."
        size="compact"
      />
    );
  }
  // dayStartIso is "YYYY-MM-DDT00:00:00.000Z"; the YYYY-MM-DD slice is the
  // UTC calendar day this cost covers (matches the window boundary exactly).
  const dayLabel = data.dayStartIso.slice(0, 10);
  return (
    <CreatorCostsTodayCard
      total={data.total}
      lines={data.lines}
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
  );
  return <ActiveRainChip rain={rain} />;
}

/**
 * Trend charts in two rows:
 *   Row 1 (3): Wagers · Deposits · FTDs              — cached getDashboardStats
 *   Row 2 (3): Daily P&L · Signups · Depositors      — P&L from getDailyPnl
 * Both data sources are awaited in parallel (getDashboardStats is cached, so
 * it's shared with the KPI strips; getDailyPnl runs alongside it). The
 * Wager Attribution chart used to live as a third full-width row here; it
 * was promoted next to the Upgrader Stats section so it sits beside the
 * other section-level analytic instead of trailing the daily charts.
 */
async function DashboardCharts({ period }: { period: DashboardPeriod }) {
  // getDashboardStats backs the wager/deposit/ftds/signup/depositor
  // charts; getDailyPnl is its OWN standalone query (historically the
  // most expensive part of the trend grid). BOTH are wrapped in safeQuery
  // so a throw degrades to a fallback instead of escaping to the route
  // error boundary (which would white-screen the whole dashboard — the
  // failure mode this page hit in prod). If getDashboardStats fails the
  // whole trends grid degrades to one panel fallback; if only getDailyPnl
  // fails just the single Daily P&L chart degrades (handled below).
  const [statsResult, pnlResult] = await Promise.all([
    safeQuery(() => getDashboardStats(period), null, "dashboard.charts"),
    safeQuery(() => getDailyPnl(), [], "dashboard.dailyPnl"),
  ]);
  if (statsResult.error || !statsResult.data) {
    return (
      <TileErrorFallback
        label="Trends"
        hint="A metrics query failed while loading the trend charts — other sections still rendered. Refresh to retry."
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
        {pnlResult.error ? (
          <TileErrorFallback
            label="Daily P&L"
            hint="The lifetime P&L scan timed out — other charts still rendered. Refresh to retry."
            size="panel"
          />
        ) : (
          <PnlChart data={pnlResult.data} />
        )}
        <SignupsChart data={stats.dailySignups} />
        <ActiveDepositorsChart data={stats.dailyActiveDepositors} />
      </div>
    </FadeIn>
  );
}

/**
 * Wager Attribution chart, hoisted into its own server component so it
 * can render alongside the Upgrader Stats panel in the 50/50 row above
 * the Trends grid. Reads from the React-cached getDashboardStats — the
 * call dedupes against the KPI strips + charts within the same render,
 * so this segment adds no extra query.
 */
async function DashboardWagerAttribution({
  period,
}: {
  period: DashboardPeriod;
}) {
  // Wrapped in safeQuery so a failing stats aggregate degrades this chart
  // (the right half of the Upgrader/Attribution row) to a fallback panel
  // instead of escaping to the route error boundary and white-screening
  // the whole dashboard.
  const { data: stats, error } = await safeQuery(
    () => getDashboardStats(period),
    null,
    "dashboard.wagerAttribution",
  );
  if (error || !stats) {
    return (
      <TileErrorFallback
        label="Wager Attribution"
        hint="The wager-attribution series failed to load — other sections still rendered. Refresh to retry."
        size="panel"
        className="h-full min-h-[400px]"
      />
    );
  }
  return <WagerAttributionChart data={stats.dailyWagerAttribution} />;
}

// `DashboardActivityFeed` was removed when the Recent Activity card moved
// into the docked widget (<DockedRecentActivity />) in the admin shell.
// The widget owns its own 24h count strip via `getActivityCounts24h`, so
// the dashboard page no longer needs a server-side wrapper for it.
