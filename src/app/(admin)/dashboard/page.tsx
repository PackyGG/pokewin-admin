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
import { getDashboardStats } from "@/lib/queries/dashboard";
import { requirePageAccess } from "@/lib/dal";
import { formatCurrency } from "@/lib/utils/format";
import { StatCard } from "./stat-card";
import {
  PnlStatCard,
  GgrStatCard,
  WagerStatCard,
  DepositsStatCard,
  WithdrawalsStatCard,
} from "./revenue-stat-card";
import { AutoRefresh } from "./auto-refresh";
import { WagerChart, DepositsChart, SignupsChart } from "./charts";
import { RecentActivity, RecentActivityLivePulse } from "./recent-activity";
import { LiveDeposits } from "./live-deposits";
import { PageHero, PageHeroIdentity, SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  await requirePageAccess("/dashboard");

  // Only the KPI stats are fetched server-side. The two live feeds
  // (Recent Activity, Live Deposits) bootstrap their own snapshot on the
  // client — that keeps the 60s router.refresh() below scoped to the
  // KPIs and stops it from re-running getLiveActivity/getLiveDeposits
  // every minute for data the feeds already own via SSE / polling.
  const stats = await getDashboardStats();

  // Average deposit transactions per hour. depositCounts holds the
  // completed-deposit count per rolling window, so dividing by the
  // window length in hours gives the per-hour rate. 24h is the hero
  // (smooths a full peak/off-peak day); 7d is the longer baseline.
  const depositsPerHour24h = (stats.depositCounts["24h"] ?? 0) / 24;
  const depositsPerHour7d = (stats.depositCounts["7d"] ?? 0) / (7 * 24);

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
        />
      </PageHero>

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

      {/* Charts. Three-up at lg+ but stacks to a single column on
          phones so each chart keeps a readable height (Recharts crushes
          when forced into a tight grid cell). At md we go 2-up so the
          row stays balanced before we have room for the third. */}
      <div className="space-y-3">
        <SectionHeading icon={LineChart} title="Trends" />
        <FadeIn className="grid gap-3 sm:gap-4 md:grid-cols-2 lg:grid-cols-3">
          <WagerChart data={stats.dailyWagers} />
          <DepositsChart data={stats.dailyDeposits} />
          <SignupsChart data={stats.dailySignups} />
        </FadeIn>
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
            <RecentActivity
              signups24h={stats.activity.signups24h}
              packsOpened24h={stats.activity.packsOpened24h}
              battlesPlayed24h={stats.activity.battlesPlayed24h}
            />
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
