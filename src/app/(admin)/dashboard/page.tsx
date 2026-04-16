import {
  ArrowDownToLine,
  Percent,
  Wallet,
  Coins,
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
          title="Total Deposits"
          value={formatNumber(stats.financials.depositCount)}
          subtitle={`${formatCurrency(stats.financials.totalDeposited)} lifetime deposited`}
          icon={ArrowDownToLine}
          color="blue"
        />
        <StatCard
          title="Users Total Balance"
          value={formatCurrency(stats.financials.totalSiteBalance + stats.financials.totalInventoryValue)}
          subtitle={`${formatCurrency(stats.financials.totalSiteBalance)} cash · ${formatCurrency(stats.financials.totalInventoryValue)} unsold inventory`}
          icon={Wallet}
          color="green"
        />
        <StatCard
          title="Avg Deposit"
          value={formatCurrency(stats.financials.avgDeposit)}
          subtitle="Across all users (lifetime)"
          icon={Coins}
          color="orange"
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
        <WagerChart data={stats.dailyWagers} />
        <DepositsChart data={stats.dailyDeposits} />
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
