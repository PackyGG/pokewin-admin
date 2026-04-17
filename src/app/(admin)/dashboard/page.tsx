import {
  Users,
  Percent,
  Wallet,
  Coins,
  LayoutDashboard,
  Activity,
  LineChart,
  Sparkles,
} from "lucide-react";
import { getDashboardStats } from "@/lib/queries/dashboard";
import { getLiveActivity } from "@/lib/queries/dashboard-live";
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
import { LivePulls } from "./live-pulls";
import { PageHero, SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  await requirePageAccess("/dashboard");

  const [stats, liveActivity] = await Promise.all([
    getDashboardStats(),
    getLiveActivity({ sinceCreatedAt: null, limit: 50 }),
  ]);

  return (
    <div className="space-y-6">
      <AutoRefresh />

      <PageHero>
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
            <LayoutDashboard className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold leading-tight">Dashboard</h1>
            <p className="text-sm text-muted-foreground">
              Live platform overview — revenue, users, and recent activity.
            </p>
          </div>
        </div>
      </PageHero>

      {/* Primary stats — period-aware cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <PnlStatCard pnl={stats.realizedPnl} />
        <GgrStatCard ggr={stats.ggr} />
        <WagerStatCard wagers={stats.wagers} />
        <DepositsStatCard deposits={stats.deposits} />
        <WithdrawalsStatCard withdrawals={stats.withdrawals} />
      </div>

      {/* Secondary stats — all-time / snapshot */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Total Users"
          animatedValue={stats.users.total}
          formatKind="number"
          subtitle={`+${stats.users.today} today, +${stats.users.week} this week`}
          icon={Users}
          color="blue"
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

      {/* Charts */}
      <div className="space-y-3">
        <SectionHeading icon={LineChart} title="Trends" />
        <FadeIn className="grid gap-4 lg:grid-cols-3">
          <WagerChart data={stats.dailyWagers} />
          <DepositsChart data={stats.dailyDeposits} />
          <SignupsChart data={stats.dailySignups} />
        </FadeIn>
      </div>

      {/* Live feeds — Recent Activity (SSE, dashboard-side ledger events) on
          the left, Live Pulls (packy.gg WS) on the right. Stacks to a
          single column on smaller screens so the pulls card keeps a
          usable width. Both cards manage their own height cap via
          internal scroll so the grid stays symmetric. */}
      <div className="grid gap-4 xl:grid-cols-2">
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
          <SectionHeading icon={Sparkles} title="Live Pulls" />
          <FadeIn>
            <LivePulls />
          </FadeIn>
        </div>
      </div>
    </div>
  );
}
