import {
  BarChart3,
  DollarSign,
  MousePointerClick,
  UserPlus,
  Percent,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { getAffiliateAnalytics } from "@/lib/queries/creators";
import { StatCard } from "../../dashboard/stat-card";
import { PeriodFilter } from "./period-filter";
import { CreatorAnalyticsCharts } from "./charts";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
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
        <PageHeroIdentity
          icon={BarChart3}
          title="Creator Analytics"
          subtitle="Affiliate performance — signups, commission, wagers, clicks."
          action={<PeriodFilter />}
        />
      </PageHero>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <StatCard
          title="Affiliate Signups"
          animatedValue={data.totalSignups}
          formatKind="number"
          subtitle="Users registered via an affiliate code"
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
        {/* Click → signup conversion. Now meaningful because signups
            count real `usage_type = 'signup'` rows rather than deposits.
            Guard against divide-by-zero when there are no clicks yet. */}
        <StatCard
          title="Conversion Rate"
          animatedValue={
            data.totalClicks > 0
              ? (data.totalSignups / data.totalClicks) * 100
              : 0
          }
          formatKind="percent"
          subtitle={`${data.totalSignups} signups / ${data.totalClicks} clicks`}
          icon={Percent}
          color="emerald"
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
