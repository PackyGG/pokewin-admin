import {
  Users,
  ArrowDownToLine,
  Package,
  Percent,
  Wallet,
  Clock,
} from "lucide-react";
import { getDashboardStats, getRecentActivity } from "@/lib/queries/dashboard";
import { requirePageAccess } from "@/lib/dal";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { StatCard } from "./stat-card";
import { PnlStatCard, GgrStatCard, WagerStatCard } from "./revenue-stat-card";
import { AutoRefresh } from "./auto-refresh";
import { RevenueChart, WagerChart, SignupsChart } from "./charts";
import { RecentActivity } from "./recent-activity";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";

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
      <h1 className="text-page-title">Dashboard</h1>

      {/* Stat cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <PnlStatCard pnl={stats.realizedPnl} />
        <GgrStatCard ggr={stats.ggr} />
        <WagerStatCard wagers={stats.wagers} />
        <StatCard
          title="Deposits & Withdrawals"
          value={formatCurrency(stats.financials.totalDeposited)}
          subtitle={`${formatCurrency(stats.financials.totalWithdrawn)} withdrawn · ${stats.financials.pendingWithdrawalsCount} in progress (${formatCurrency(stats.financials.pendingWithdrawalsValue)})`}
          icon={ArrowDownToLine}
          color="orange"
        />
        <StatCard
          title="Total Users"
          value={formatNumber(stats.users.total)}
          subtitle={`+${stats.users.today} today, +${stats.users.week} this week`}
          icon={Users}
          color="blue"
        />
      </div>

      {/* Secondary stat cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Users Total Balance"
          value={formatCurrency(stats.financials.totalSiteBalance + stats.financials.totalInventoryValue)}
          subtitle={`${formatCurrency(stats.financials.totalSiteBalance)} cash · ${formatCurrency(stats.financials.totalInventoryValue)} unsold inventory`}
          icon={Wallet}
          color="green"
        />
        <StatCard
          title="Pending Confirmations"
          value={formatNumber(stats.financials.pendingConfirmationCount)}
          subtitle={`${formatCurrency(stats.financials.pendingConfirmationValue)} awaiting admin action`}
          icon={Clock}
          color="orange"
        />
        <StatCard
          title="Pack Openings"
          value={formatNumber(stats.activity.totalPacksOpened)}
          subtitle={`${formatNumber(stats.activity.totalBattlesPlayed)} battles`}
          icon={Package}
          color="purple"
        />
        <StatCard
          title="Avg RTP"
          value={`${(stats.financials.totalWagered > 0 ? (stats.financials.totalWon / stats.financials.totalWagered) * 100 : 0).toFixed(2)}%`}
          icon={Percent}
          color="pink"
        />
      </div>

      {/* Charts */}
      <div className="grid gap-4 lg:grid-cols-3">
        <RevenueChart data={stats.dailyRevenue} />
        <WagerChart data={stats.dailyWagers} />
        <SignupsChart data={stats.dailySignups} />
      </div>

      {/* Recent activity */}
      <RecentActivity items={activity.data} />
      <DataTablePagination
        page={activity.page}
        totalPages={activity.totalPages}
        total={activity.total}
        perPage={activity.perPage}
      />
    </div>
  );
}
