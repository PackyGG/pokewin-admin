import {
  DollarSign,
  MousePointerClick,
  UserPlus,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { getAffiliateAnalytics } from "@/lib/queries/creators";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { StatCard } from "../../dashboard/stat-card";
import { PeriodFilter } from "./period-filter";
import { CreatorAnalyticsCharts } from "./charts";

export const metadata = { title: "Creator Analytics" };

export default async function CreatorAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/creators/analytics");
  const params = await searchParams;
  const period = (params.period ?? "30d") as
    | "today"
    | "7d"
    | "30d"
    | "90d"
    | "all";

  const data = await getAffiliateAnalytics(period);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Creator Analytics</h1>
        <PeriodFilter />
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <StatCard
          title="Affiliate Signups"
          value={formatNumber(data.totalSignups)}
          subtitle="Via affiliate deposit codes"
          icon={UserPlus}
          color="purple"
        />
        <StatCard
          title="Commission Paid"
          value={formatCurrency(data.totalCommissionPaid)}
          subtitle="Total paid to affiliates"
          icon={DollarSign}
          color="green"
        />
        <StatCard
          title="Wager Volume"
          value={formatCurrency(data.totalWagerVolume)}
          subtitle="From referred users"
          icon={TrendingUp}
          color="blue"
        />
        <StatCard
          title="Deposit Volume"
          value={formatCurrency(data.totalDepositVolume)}
          subtitle="From referred users"
          icon={Wallet}
          color="cyan"
        />
        <StatCard
          title="Total Clicks"
          value={formatNumber(data.totalClicks)}
          subtitle="Affiliate link clicks"
          icon={MousePointerClick}
          color="orange"
        />
        <StatCard
          title="Active Creators"
          value={formatNumber(data.activeCreators)}
          subtitle="With active affiliate codes"
          icon={Users}
          color="pink"
        />
      </div>

      <CreatorAnalyticsCharts data={data.daily} />
    </div>
  );
}
