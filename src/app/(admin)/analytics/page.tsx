import {
  DollarSign,
  TrendingUp,
  Eye,
  UserPlus,
  Package,
  Swords,
  BarChart3,
} from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { getAnalyticsData } from "@/lib/queries/analytics";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { StatCard } from "../dashboard/stat-card";
import { AutoRefresh } from "../dashboard/auto-refresh";
import { PeriodFilter } from "./period-filter";
import { AnalyticsCharts } from "./charts";
import { BattleModesSection, PackPopularitySection } from "./sections";
import { PageHero } from "@/components/modern-panels";

export const metadata = { title: "Analytics" };

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/analytics");
  const params = await searchParams;
  const period = (params.period ?? "30d") as
    | "today"
    | "7d"
    | "30d"
    | "90d"
    | "all";

  const data = await getAnalyticsData(period);

  const totalWager = data.packWager + data.battleWager;
  const packPct =
    totalWager > 0 ? ((data.packWager / totalWager) * 100).toFixed(1) : "0";
  const battlePct =
    totalWager > 0 ? ((data.battleWager / totalWager) * 100).toFixed(1) : "0";
  const packBorrowPct =
    data.packWager > 0
      ? ((data.packWagerBorrowed / data.packWager) * 100).toFixed(1)
      : "0";
  const battleBorrowPct =
    data.battleWager > 0
      ? ((data.battleWagerBorrowed / data.battleWager) * 100).toFixed(1)
      : "0";

  return (
    <div className="space-y-6">
      <AutoRefresh />
      <PageHero>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
              <BarChart3 className="size-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold leading-tight">Analytics</h1>
              <p className="text-sm text-muted-foreground">
                Revenue, acquisition, and gameplay metrics over time.
              </p>
            </div>
          </div>
          <PeriodFilter />
        </div>
      </PageHero>

      {/* Stat Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <StatCard
          title="Realized Profit"
          value={formatCurrency(data.realizedProfit)}
          subtitle={`Dep ${formatCurrency(data.realizedProfitBreakdown.totalDeposits)} − WD ${formatCurrency(data.realizedProfitBreakdown.totalWithdrawals)} − Bal ${formatCurrency(data.realizedProfitBreakdown.userBalance)} − Inv ${formatCurrency(data.realizedProfitBreakdown.inventory)} − Vouchers ${formatCurrency(data.realizedProfitBreakdown.vouchers)} − Rakeback ${formatCurrency(data.realizedProfitBreakdown.unclaimedRakeback)}`}
          icon={TrendingUp}
          color="green"
        />
        <StatCard
          title="GGR (Gross Gaming Revenue)"
          value={formatCurrency(data.ggr)}
          subtitle={`${formatCurrency(totalWager)} wagered total`}
          icon={DollarSign}
          color="blue"
        />
        <StatCard
          title="Unique Visitors"
          value={formatNumber(data.uniqueVisitors)}
          subtitle="Distinct users with transactions"
          icon={Eye}
          color="cyan"
        />
        <StatCard
          title="New Signups"
          value={formatNumber(data.newSignups)}
          subtitle={`${data.uniqueVisitors > 0 ? ((data.newSignups / data.uniqueVisitors) * 100).toFixed(1) : "0"}% of active users`}
          icon={UserPlus}
          color="purple"
        />
        <StatCard
          title="Pack Wagers"
          value={formatCurrency(data.packWager)}
          subtitle={`${packPct}% of total wagers`}
          icon={Package}
          color="orange"
        >
          <p className="text-stat-label mt-1">
            {formatCurrency(data.packWagerBorrowed)} borrowed ({packBorrowPct}%)
          </p>
        </StatCard>
        <StatCard
          title="Battle Wagers"
          value={formatCurrency(data.battleWager)}
          subtitle={`${battlePct}% of total wagers`}
          icon={Swords}
          color="pink"
        >
          <p className="text-stat-label mt-1">
            {formatCurrency(data.battleWagerBorrowed)} borrowed ({battleBorrowPct}%)
          </p>
        </StatCard>
      </div>

      {/* Battle / Pack Breakdown */}
      <div className="space-y-4">
        <BattleModesSection stats={data.battleStats} />
        <PackPopularitySection stats={data.packStats} />
      </div>

      {/* Charts */}
      <AnalyticsCharts data={data.daily} />
    </div>
  );
}
