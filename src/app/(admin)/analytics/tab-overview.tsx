import {
  DollarSign,
  TrendingUp,
  Eye,
  UserPlus,
  Package,
  Swords,
} from "lucide-react";
import { getAnalyticsData } from "@/lib/queries/analytics";
import { formatCurrency } from "@/lib/utils/format";
import { StatCard } from "../dashboard/stat-card";
import { AnalyticsCharts } from "./charts";
import { FadeIn } from "@/components/fade-in";
import type { AnalyticsPeriod } from "./types";

/**
 * Default tab — renders the headline KPIs and the daily chart grid.
 * The battle/pack breakdown sections live on the dedicated
 * "Pack & Battle" tab so the overview stays focused on high-level KPIs.
 */
export async function OverviewTab({ period }: { period: AnalyticsPeriod }) {
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
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <StatCard
          title="Realized Profit"
          animatedValue={data.realizedProfit}
          formatKind="currency"
          subtitle={`Dep ${formatCurrency(data.realizedProfitBreakdown.totalDeposits)} − WD ${formatCurrency(data.realizedProfitBreakdown.totalWithdrawals)} − Bal ${formatCurrency(data.realizedProfitBreakdown.userBalance)} − Inv ${formatCurrency(data.realizedProfitBreakdown.inventory)} − Vouchers ${formatCurrency(data.realizedProfitBreakdown.vouchers)} − Rakeback ${formatCurrency(data.realizedProfitBreakdown.unclaimedRakeback)}`}
          icon={TrendingUp}
          color="green"
        />
        <StatCard
          title="GGR (Gross Gaming Revenue)"
          animatedValue={data.ggr}
          formatKind="currency"
          subtitle={`${formatCurrency(totalWager)} wagered total`}
          icon={DollarSign}
          color="emerald"
        />
        <StatCard
          title="Unique Visitors"
          animatedValue={data.uniqueVisitors}
          formatKind="number"
          subtitle="Distinct users with transactions"
          icon={Eye}
          color="cyan"
        />
        <StatCard
          title="New Signups"
          animatedValue={data.newSignups}
          formatKind="number"
          subtitle={`${data.uniqueVisitors > 0 ? ((data.newSignups / data.uniqueVisitors) * 100).toFixed(1) : "0"}% of active users`}
          icon={UserPlus}
          color="purple"
        />
        <StatCard
          title="Pack Wagers"
          animatedValue={data.packWager}
          formatKind="currency"
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
          animatedValue={data.battleWager}
          formatKind="currency"
          subtitle={`${battlePct}% of total wagers`}
          icon={Swords}
          color="pink"
        >
          <p className="text-stat-label mt-1">
            {formatCurrency(data.battleWagerBorrowed)} borrowed (
            {battleBorrowPct}%)
          </p>
        </StatCard>
      </div>

      <FadeIn>
        <AnalyticsCharts data={data.daily} />
      </FadeIn>
    </div>
  );
}
