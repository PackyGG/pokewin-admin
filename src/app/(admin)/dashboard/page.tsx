import { Suspense } from "react";
import {
  Users,
  Percent,
  Wallet,
  Coins,
  LayoutDashboard,
  Activity,
  LineChart,
  BadgeDollarSign,
  HandCoins,
  Gauge,
} from "lucide-react";
import {
  getDashboardStats,
  getActiveRain,
  parseDashboardPeriod,
  type DashboardPeriod,
} from "@/lib/queries/dashboard";
import { DashboardPeriodSelector } from "./dashboard-period-selector";
import { getUpgraderStats } from "@/lib/queries/dashboard-upgrader";
import { getDailyPnl } from "@/lib/queries/pnl";
import { requirePageAccess } from "@/lib/dal";
import { formatCurrency } from "@/lib/utils/format";
import { LoadTimeIndicator } from "./load-time-indicator";
import { StatCard } from "./stat-card";
import {
  PnlStatCard,
  GgrStatCard,
  WagerStatCard,
  DepositsStatCard,
  WithdrawalsStatCard,
} from "./revenue-stat-card";
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
import {
  RecentActivity,
  RecentActivityLivePulse,
  RecentActivitySkeleton,
} from "./recent-activity";
import { LiveDeposits } from "./live-deposits";
import { UpgraderStatsSection } from "./upgrader-stats";
import { ActiveRainChip } from "./active-rain-chip";
import { PageHero, PageHeroIdentity, SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import {
  KpiStripSkeleton,
  ChartRowSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

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

  // The two live feeds (Recent Activity, Live Deposits) bootstrap their
  // own snapshot on the client — that keeps the 60s router.refresh()
  // below scoped to the KPIs and stops it from re-running
  // getLiveActivity/getLiveDeposits every minute for data the feeds
  // already own via SSE / polling. LiveDeposits needs no server stats so
  // it renders directly in the shell; RecentActivity's 24h count strip
  // does, so it streams behind Suspense (its live feed still connects on
  // client mount regardless).
  return (
    <div className="space-y-6">
      {/* Dashboard polls at 60s for the KPI numbers only — KPIs settle
          slowly and the live feeds (RecentActivity SSE, LiveDeposits
          polling) own their own data on the client, so this refresh no
          longer re-queries the feeds. */}
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
          grids in DashboardStatStrips. */}
      <Suspense
        key={`stats-${period}`}
        fallback={
          <>
            <KpiStripSkeleton count={7} />
            <KpiStripSkeleton count={7} />
          </>
        }
      >
        <DashboardStatStrips period={period} />
      </Suspense>

      {/* Upgrader Stats — its own section between the KPI strips and
          the trend graphs. Streams behind its own Suspense (separate
          query, not bolted onto getDashboardStats) so the headline
          KPIs aren't blocked by the upgrader scan. */}
      <Suspense
        fallback={
          <Skeleton className="h-[176px] w-full rounded-2xl" />
        }
      >
        <DashboardUpgraderSection />
      </Suspense>

      {/* Charts. Three-up at lg+ but stacks to a single column on
          phones so each chart keeps a readable height (Recharts crushes
          when forced into a tight grid cell). At md we go 2-up so the
          row stays balanced before we have room for the third. */}
      <div className="space-y-3">
        <SectionHeading icon={LineChart} title="Trends" />
        {/* Row 1: Wagers · Deposits · FTDs.
            Row 2: Daily P&L · Signups · Depositors.
            Row 3: Wager Attribution (organic vs creator-coded, full width).
            One boundary — the row-1/2 charts share the cached
            getDashboardStats and the standalone getDailyPnl runs in
            parallel with it. */}
        <Suspense
          key={`charts-${period}`}
          fallback={
            <>
              <ChartRowSkeleton count={3} height={300} />
              <ChartRowSkeleton count={3} height={300} />
              <ChartRowSkeleton count={1} height={300} />
            </>
          }
        >
          <DashboardCharts period={period} />
        </Suspense>
      </div>

      {/* Live feeds — Recent Activity (SSE, dashboard-side ledger events) on
          the left, Live Deposits (6s polling) on the right. Both feeds
          self-bootstrap their snapshot on the client (no server-rendered
          seed), so the 60s dashboard refresh doesn't re-query them.
          Stacks to a single column on smaller screens so the deposits
          card keeps a usable width. Both cards manage their own height
          cap via internal scroll so the grid stays symmetric. */}
      <div className="grid gap-3 sm:gap-4 xl:grid-cols-2">
        <div className="space-y-3">
          <SectionHeading
            icon={Activity}
            title="Recent Activity"
            action={<RecentActivityLivePulse />}
          />
          <FadeIn>
            {/* Only the 24h count strip atop this card needs server
                stats; the live event list self-bootstraps on the client.
                Streaming it keeps the heavy stats query off the page's
                first paint. The fallback is a plain skeleton (NOT a live
                RecentActivity) so we never open a throwaway SSE
                connection that gets torn down the moment stats resolve. */}
            <Suspense fallback={<RecentActivitySkeleton />}>
              <DashboardActivityFeed period={period} />
            </Suspense>
          </FadeIn>
        </div>
        <div className="space-y-3">
          <SectionHeading icon={Wallet} title="Deposits" />
          <FadeIn>
            <LiveDeposits />
          </FadeIn>
        </div>
      </div>
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
  const stats = await getDashboardStats(period);
  return (
    <LoadTimeIndicator
      queryMs={stats.queryMs}
      generatedAt={stats.generatedAt}
    />
  );
}

/**
 * Primary (period-aware) + secondary (snapshot) KPI strips. Async so it
 * streams behind the page-level Suspense; reads the React-cached
 * getDashboardStats.
 */
async function DashboardStatStrips({ period }: { period: DashboardPeriod }) {
  const stats = await getDashboardStats(period);

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
          squeezing 2-up at 380px crushed both). 2-up at sm, 3 at lg,
          7 across at xl (PnL, GGR, Total Wager, Raw Wager, Organic
          Wager, Deposits, Withdrawals). */}
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 xl:grid-cols-7">
        <PnlStatCard
          pnl={stats.realizedPnl}
          pnlPeriod={stats.realizedPnlPeriod}
          periodLabel={stats.periodLabel}
        />
        <GgrStatCard ggr={stats.ggr} periodLabel={stats.periodLabel} />
        {/* Two wager cards: "Total Wager" drops wagers a creator made
            while live on a deal/stream (house-funded sponsored balance,
            not a real customer bet); "Raw Wager" includes them. The gap
            between the two is the creator on-stream sponsored wager. */}
        <WagerStatCard
          wager={stats.wagers}
          periodLabel={stats.periodLabel}
          caption="excl. creator sessions"
          breakdown={stats.wagersBreakdown}
        />
        <WagerStatCard
          wager={stats.wagersRaw}
          periodLabel={stats.periodLabel}
          title="Raw Wager"
          caption="incl. creator sessions"
        />
        {/* Organic Wager — only counts users who did NOT join under an
            official creator code. Drops creator-on-stream play AND
            creator-attributed customer wager, so the gap between
            "Total Wager" (excl. creator sessions) and this card is the
            wager that's downstream of creator marketing. */}
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
  const stats = await getUpgraderStats();
  return <UpgraderStatsSection stats={stats} />;
}

/**
 * Active Rain box. Its own lightweight query (a single rains row), streamed
 * behind its own Suspense so it never blocks the heavy stats aggregate and
 * refreshes on the dashboard's 60s tick.
 */
async function DashboardActiveRain() {
  const rain = await getActiveRain();
  return <ActiveRainChip rain={rain} />;
}

/**
 * Trend charts in three rows:
 *   Row 1 (3): Wagers · Deposits · FTDs              — cached getDashboardStats
 *   Row 2 (3): Daily P&L · Signups · Depositors      — P&L from getDailyPnl
 *   Row 3 (1): Wager Attribution (organic vs creator-coded, full width)
 * Both data sources are awaited in parallel (getDashboardStats is cached, so
 * it's shared with the KPI strips; getDailyPnl runs alongside it). The
 * Wager Attribution chart gets its own row at full width so 30 daily bars
 * stay legible and the split between the two bands reads at a glance.
 */
async function DashboardCharts({ period }: { period: DashboardPeriod }) {
  const [stats, dailyPnl] = await Promise.all([
    getDashboardStats(period),
    getDailyPnl(),
  ]);
  return (
    <FadeIn className="space-y-3 sm:space-y-4">
      <div className="grid gap-3 sm:gap-4 md:grid-cols-2 lg:grid-cols-3">
        <WagerChart data={stats.dailyWagers} />
        <DepositsChart data={stats.dailyDeposits} />
        <FtdsChart data={stats.dailyFtds} />
      </div>
      <div className="grid gap-3 sm:gap-4 md:grid-cols-2 lg:grid-cols-3">
        <PnlChart data={dailyPnl} />
        <SignupsChart data={stats.dailySignups} />
        <ActiveDepositorsChart data={stats.dailyActiveDepositors} />
      </div>
      <div className="grid gap-3 sm:gap-4">
        <WagerAttributionChart data={stats.dailyWagerAttribution} />
      </div>
    </FadeIn>
  );
}

/**
 * Recent Activity card. Only its 24h count strip needs server stats; the
 * live event list self-bootstraps on the client (SSE / polling). Async so
 * the count strip streams behind Suspense without blocking first paint.
 */
async function DashboardActivityFeed({ period }: { period: DashboardPeriod }) {
  const stats = await getDashboardStats(period);
  return (
    <RecentActivity
      signups24h={stats.activity.signups24h}
      packsOpened24h={stats.activity.packsOpened24h}
      battlesPlayed24h={stats.activity.battlesPlayed24h}
    />
  );
}
