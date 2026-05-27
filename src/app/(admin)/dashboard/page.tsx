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
import { getDashboardStats, getActiveRain } from "@/lib/queries/dashboard";
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

export default async function DashboardPage() {
  await requirePageAccess("/dashboard");

  // The KPI numbers come from getDashboardStats — a heavy 17-query
  // aggregate. Instead of awaiting it before the page renders anything,
  // the static shell (hero, section headings, live feeds) paints
  // immediately and each stats-fed segment streams in behind its own
  // Suspense boundary. getDashboardStats is React-cached, so the three
  // segments below share a single execution per render.
  //
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
                <DashboardLoadTime />
              </Suspense>
            </div>
          }
        />
      </PageHero>

      {/* Primary + secondary KPI strips stream together — they share the
          same getDashboardStats fetch, so splitting them into separate
          boundaries would just show two skeletons resolving at the same
          instant. Fallback mirrors the 6-up primary + 7-up secondary
          grids in DashboardStatStrips. */}
      <Suspense
        fallback={
          <>
            <KpiStripSkeleton count={6} />
            <KpiStripSkeleton count={7} />
          </>
        }
      >
        <DashboardStatStrips />
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
        {/* Row 1: Wagers · Deposits · FTDs. Row 2: Daily P&L · Signups.
            One boundary — the row-1/Signups charts share the cached
            getDashboardStats and the standalone getDailyPnl runs in
            parallel with it. */}
        <Suspense
          fallback={
            <>
              <ChartRowSkeleton count={3} height={300} />
              <ChartRowSkeleton count={2} height={300} />
            </>
          }
        >
          <DashboardCharts />
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
              <DashboardActivityFeed />
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
async function DashboardLoadTime() {
  const stats = await getDashboardStats();
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
async function DashboardStatStrips() {
  const stats = await getDashboardStats();

  // Average deposit transactions per hour. depositCounts holds the
  // completed-deposit count per rolling window, so dividing by the
  // window length in hours gives the per-hour rate. 24h is the hero
  // (smooths a full peak/off-peak day); 7d is the longer baseline.
  const depositsPerHour24h = (stats.depositCounts["24h"] ?? 0) / 24;
  const depositsPerHour7d = (stats.depositCounts["7d"] ?? 0) / (7 * 24);

  return (
    <>
      {/* Primary stats — period-aware cards.
          Mobile-first grid: ONE column at <sm so each card is full-
          width and the dollar value never truncates (these cards
          contain a 5-chip period selector + a hero currency value;
          squeezing 2-up at 380px crushed both). 2-up at sm, 3 at lg,
          6 across at xl. */}
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 xl:grid-cols-6">
        <PnlStatCard pnl={stats.realizedPnl} pnl24h={stats.realizedPnl24h} />
        <GgrStatCard ggr={stats.ggr} />
        {/* Two wager cards: "Total Wager" drops wagers a creator made
            while live on a deal/stream (house-funded sponsored balance,
            not a real customer bet); "Raw Wager" includes them. The gap
            between the two is the creator on-stream sponsored wager. */}
        <WagerStatCard
          wagers={stats.wagers}
          caption="excl. creator sessions"
          breakdown={stats.wagersBreakdown}
        />
        <WagerStatCard
          wagers={stats.wagersRaw}
          title="Raw Wager"
          caption="incl. creator sessions"
        />
        <DepositsStatCard
          deposits={stats.deposits}
          depositCounts={stats.depositCounts}
        />
        <WithdrawalsStatCard withdrawals={stats.withdrawals} />
      </div>

      {/* Secondary stats — all-time / snapshot. These are simpler
          (no period chips) so they tolerate 2-up on phone, 3-up at
          sm, then 6 across at lg+. */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 sm:gap-4 lg:grid-cols-6 xl:grid-cols-7">
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
        {/* Users Total Balance is a HOUSE LIABILITY but we accent it orange
            (not rose) so it's visually distinct from the Withdrawals / PnL
            cards that also use rose. The magnitude is what admins care about
            here, not a direction signal.

            Liability total = on-site cash + held inventory (unsold cards) +
            unclaimed vouchers. Vouchers are real owed balance the user can
            still redeem, so they belong in the same liability figure as cash
            and inventory (they were previously omitted from this tile). */}
        <StatCard
          title="Users Total Balance"
          animatedValue={
            stats.financials.totalSiteBalance +
            stats.financials.totalInventoryValue +
            stats.financials.totalUnclaimedVouchers
          }
          formatKind="currency"
          subtitle={`${formatCurrency(stats.financials.totalSiteBalance)} cash · ${formatCurrency(stats.financials.totalInventoryValue)} inventory · ${formatCurrency(stats.financials.totalUnclaimedVouchers)} vouchers`}
          icon={Wallet}
          color="orange"
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
 * Trend charts in two rows:
 *   Row 1 (3): Wagers · Deposits · FTDs   — from the cached getDashboardStats
 *   Row 2 (2): Daily P&L · Signups        — P&L from standalone getDailyPnl
 * Both data sources are awaited in parallel (getDashboardStats is cached, so
 * it's shared with the KPI strips; getDailyPnl runs alongside it).
 */
async function DashboardCharts() {
  const [stats, dailyPnl] = await Promise.all([
    getDashboardStats(),
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
    </FadeIn>
  );
}

/**
 * Recent Activity card. Only its 24h count strip needs server stats; the
 * live event list self-bootstraps on the client (SSE / polling). Async so
 * the count strip streams behind Suspense without blocking first paint.
 */
async function DashboardActivityFeed() {
  const stats = await getDashboardStats();
  return (
    <RecentActivity
      signups24h={stats.activity.signups24h}
      packsOpened24h={stats.activity.packsOpened24h}
      battlesPlayed24h={stats.activity.battlesPlayed24h}
    />
  );
}
