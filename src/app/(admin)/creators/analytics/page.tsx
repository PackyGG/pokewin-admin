import {
  BarChart3,
  DollarSign,
  MousePointerClick,
  UserPlus,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { getAffiliateAnalytics } from "@/lib/queries/creators";
import { StatCard } from "../../dashboard/stat-card";
import { PeriodFilter } from "./period-filter";
import { CreatorAnalyticsCharts } from "./charts";
import { PageHero } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

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
      <PageHero>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
              <BarChart3 className="size-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold leading-tight">
                Creator Analytics
              </h1>
              <p className="text-sm text-muted-foreground">
                Affiliate performance — signups, commission, wagers, clicks.
              </p>
            </div>
          </div>
          <PeriodFilter />
        </div>
      </PageHero>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <StatCard
          title="Affiliate Signups"
          animatedValue={data.totalSignups}
          formatKind="number"
          subtitle="Via affiliate deposit codes"
          icon={UserPlus}
          color="purple"
        />
        {/* Commission Paid = money we sent OUT to affiliates → house
            loss → rose per CLAUDE.md house-POV rule. */}
        <StatCard
          title="Commission Paid"
          animatedValue={data.totalCommissionPaid}
          formatKind="currency"
          subtitle="Total paid to affiliates"
          icon={DollarSign}
          color="rose"
        />
        <StatCard
          title="Wager Volume"
          animatedValue={data.totalWagerVolume}
          formatKind="currency"
          subtitle="From referred users"
          icon={TrendingUp}
          color="blue"
        />
        <StatCard
          title="Deposit Volume"
          animatedValue={data.totalDepositVolume}
          formatKind="currency"
          subtitle="From referred users"
          icon={Wallet}
          color="cyan"
        />
        <StatCard
          title="Total Clicks"
          animatedValue={data.totalClicks}
          formatKind="number"
          subtitle="Affiliate link clicks"
          icon={MousePointerClick}
          color="orange"
        />
        <StatCard
          title="Active Creators"
          animatedValue={data.activeCreators}
          formatKind="number"
          subtitle="With active affiliate codes"
          icon={Users}
          color="pink"
        />
      </div>

      <FadeIn>
        <CreatorAnalyticsCharts data={data.daily} />
      </FadeIn>
    </div>
  );
}
