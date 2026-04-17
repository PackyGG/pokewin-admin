import {
  Users,
  Percent,
  Wallet,
  Coins,
  LayoutDashboard,
  Activity,
  LineChart,
} from "lucide-react";
import { getDashboardStats, getRecentActivity } from "@/lib/queries/dashboard";
import { requirePageAccess } from "@/lib/dal";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { StatCard } from "./stat-card";
import {
  PnlStatCard,
  GgrStatCard,
  WagerStatCard,
  DepositsStatCard,
} from "./revenue-stat-card";
import { AutoRefresh } from "./auto-refresh";
import { WagerChart, DepositsChart, SignupsChart } from "./charts";
import { RecentActivity } from "./recent-activity";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { PageHero, SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/dashboard");
  const params = await searchParams;
  const activityPage = Number(params.page) || 1;
  const activityPerPage = Number(params.perPage) || 20;

  const [stats, activity] = await Promise.all([
    getDashboardStats(),
    getRecentActivity({ page: activityPage, perPage: activityPerPage }),
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
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <PnlStatCard pnl={stats.realizedPnl} />
        <GgrStatCard ggr={stats.ggr} />
        <WagerStatCard wagers={stats.wagers} />
        <DepositsStatCard deposits={stats.deposits} />
      </div>

      {/* Secondary stats — all-time / snapshot */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Total Users"
          animatedValue={stats.users.total}
          formatValue={(n) => formatNumber(Math.round(n))}
          subtitle={`+${stats.users.today} today, +${stats.users.week} this week`}
          icon={Users}
          color="blue"
        />
        <StatCard
          title="Users Total Balance"
          animatedValue={
            stats.financials.totalSiteBalance +
            stats.financials.totalInventoryValue
          }
          formatValue={formatCurrency}
          subtitle={`${formatCurrency(stats.financials.totalSiteBalance)} cash · ${formatCurrency(stats.financials.totalInventoryValue)} unsold inventory`}
          icon={Wallet}
          color="green"
        />
        <StatCard
          title="Avg Deposit"
          animatedValue={stats.financials.avgDeposit}
          formatValue={formatCurrency}
          subtitle="Across all users (lifetime)"
          icon={Coins}
          color="orange"
        />
        <StatCard
          title="Avg RTP"
          animatedValue={
            stats.financials.totalWagered > 0
              ? (stats.financials.totalWon / stats.financials.totalWagered) *
                100
              : 0
          }
          formatValue={(n) => `${n.toFixed(2)}%`}
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

      {/* Recent activity */}
      <div className="space-y-3">
        <SectionHeading icon={Activity} title="Recent Activity" />
        <RecentActivity items={activity.data} />
        <DataTablePagination
          page={activity.page}
          totalPages={activity.totalPages}
          total={activity.total}
          perPage={activity.perPage}
        />
      </div>
    </div>
  );
}
