import {
  Users,
  Percent,
  Wallet,
  Coins,
  LayoutDashboard,
  Activity,
  LineChart,
  BadgeDollarSign,
} from "lucide-react";
import { getDashboardStats } from "@/lib/queries/dashboard";
import { getLiveActivity, getLiveDeposits } from "@/lib/queries/dashboard-live";
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
import { Activity24hCard } from "./activity-24h-card";
import { PageHero, SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  await requirePageAccess("/dashboard");

  const [stats, liveActivity, liveDeposits] = await Promise.all([
    getDashboardStats(),
    getLiveActivity({ sinceCreatedAt: null, limit: 50 }),
    getLiveDeposits({ sinceCreatedAt: null, limit: 20 }),
  ]);

  return (
    <div className="space-y-6">
      {/* Dashboard polls at 60s — KPIs settle slowly and the live
          feeds (RecentActivity SSE, LivePulls WS) update independently. */}
      <AutoRefresh intervalMs={60_000} />

      <PageHero>
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <LayoutDashboard className="size-5 text-primary" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-bold leading-tight sm:text-2xl">Dashboard</h1>
            <p className="text-xs text-muted-foreground sm:text-sm">
              Live platform overview — revenue, users, and recent activity.
            </p>
          </div>
        </div>
      </PageHero>

      {/* Primary stats — period-aware cards.
          Mobile-first grid: ONE column at <sm so each card is full-
          width and the dollar value never truncates (these cards
          contain a 5-chip period selector + a hero currency value;
          squeezing 2-up at 380px crushed both). 2-up at sm, 3 at md,
          5 at lg. */}
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 xl:grid-cols-5">
        <PnlStatCard pnl={stats.realizedPnl} />
        <GgrStatCard ggr={stats.ggr} />
        <WagerStatCard wagers={stats.wagers} />
        <DepositsStatCard
          deposits={stats.deposits}
          depositCounts={stats.depositCounts}
        />
        <WithdrawalsStatCard withdrawals={stats.withdrawals} />
      </div>

      {/* Secondary stats — all-time / snapshot. These are simpler
          (no period chips) so they tolerate 2-up on phone, then
          widen up to 6 across (5 single-metric + the 24h Activity
          tile which packs 2 metrics in one card). */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 xl:grid-cols-6">
        {/* 24h Activity — packs opened + battles played in one tile.
            Sits first in the secondary row so it's the most prominent
            "what happened today" signal, matching the rolling-24h
            framing of the primary cards above. */}
        <Activity24hCard
          packsOpened={stats.activity.packsOpened24h}
          battlesPlayed={stats.activity.battlesPlayed24h}
        />
        <StatCard
          title="Total Users"
          animatedValue={stats.users.total}
          formatKind="number"
          subtitle={`+${stats.users.today} today, +${stats.users.week} this week`}
          icon={Users}
          color="blue"
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
            here, not a direction signal. */}
        <StatCard
          title="Users Total Balance"
          animatedValue={
            stats.financials.totalSiteBalance +
            stats.financials.totalInventoryValue
          }
          formatKind="currency"
          subtitle={`${formatCurrency(stats.financials.totalSiteBalance)} cash · ${formatCurrency(stats.financials.totalInventoryValue)} unsold inventory`}
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
          the left, Live Deposits (3s polling) on the right. Stacks to a
          single column on smaller screens so the deposits card keeps a
          usable width. Both cards manage their own height cap via
          internal scroll so the grid stays symmetric. */}
      <div className="grid gap-3 sm:gap-4 xl:grid-cols-2">
        <div className="space-y-3">
          <SectionHeading
            icon={Activity}
            title="Recent Activity"
            action={<RecentActivityLivePulse />}
          />
          <FadeIn>
            <RecentActivity initial={liveActivity} />
          </FadeIn>
        </div>
        <div className="space-y-3">
          <SectionHeading icon={Wallet} title="Deposits" />
          <FadeIn>
            <LiveDeposits
              initial={liveDeposits.items}
              initialTotal24h={liveDeposits.total24h}
            />
          </FadeIn>
        </div>
      </div>
    </div>
  );
}
