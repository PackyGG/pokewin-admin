import { Suspense } from "react";
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
import type { AffiliateAnalyticsData } from "@/lib/queries/creators-types";
import { compareCreatorsAnalytics } from "@/lib/clickhouse/compare/creators-analytics";
import { resolveAdminRead } from "@/lib/clickhouse/resolve-read";
import { getAffiliateAnalyticsFromClickHouse } from "@/lib/clickhouse/queries/creators/analytics";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import {
  KpiStripSkeleton,
  ChartRowSkeleton,
} from "@/components/loading-skeletons";
import { PeriodFilter } from "./period-filter";
import { CreatorAnalyticsCharts } from "./charts";
import {
  PageHero,
  PageHeroIdentity,
  MetricTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

export const metadata = { title: "Creator Analytics" };

type CreatorAnalyticsPeriod = "today" | "7d" | "30d" | "90d" | "all";

export default async function CreatorAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/creators/analytics");
  const params = await searchParams;
  const period = (params.period ?? "30d") as CreatorAnalyticsPeriod;

  // Paint the hero shell instantly; the affiliate aggregate streams in behind
  // its own Suspense boundary (keyed on period so a period switch re-streams),
  // so the page no longer blocks first paint on the multi-query batch.
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

      <Suspense
        key={period}
        fallback={
          <>
            {/* Pin the skeleton grid to the SAME shape as the real
                <MetricTile> grid below (grid-cols-2 sm:grid-cols-3
                lg:grid-cols-4). Without this override the 7-tile default
                lays out a single lg:grid-cols-7 row, so streaming in the
                real two-row (4+3) grid — and every period switch — would
                jump both the column count and the height (CLS). */}
            <KpiStripSkeleton
              count={7}
              className="grid-cols-2 sm:grid-cols-3 lg:grid-cols-4"
            />
            <ChartRowSkeleton count={2} height={300} />
          </>
        }
      >
        <CreatorAnalyticsBody period={period} />
      </Suspense>
    </div>
  );
}

async function CreatorAnalyticsBody({
  period,
}: {
  period: CreatorAnalyticsPeriod;
}) {
  // CQRS serve-path: clickhouse mode serves the CH twin (SOLE read, throws on
  // failure); off/comparison serve Postgres. The CH twin returns the SAME full
  // `AffiliateAnalyticsData` (scalars + per-day series) the page renders.
  // safeQuery + a statement timeout degrade a slow/failed read to a panel
  // fallback instead of hanging the segment or escaping to the route boundary.
  const { data, error } = await safeQuery(
    () =>
      resolveAdminRead<AffiliateAnalyticsData>("creators_analytics", {
        pg: () => getAffiliateAnalytics(period),
        ch: async () =>
          getAffiliateAnalyticsFromClickHouse(
            period,
            await getExcludedUserIds(),
            new Date(),
          ),
      }),
    null,
    "creators.analytics",
    REWARD_QUERY_TIMEOUT_MS,
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Creator analytics"
        hint="The affiliate analytics query failed — refresh or switch period to retry."
        size="panel"
      />
    );
  }
  void compareCreatorsAnalytics(period, data);

  return (
    <>
      {/* Modern KPI grid — migrated off the legacy <StatCard>/<Card> to
          the shared <MetricTile> primitive (accent bar + glassy sheen,
          matching the rest of the admin). Money tiles follow CLAUDE.md
          house-POV STRICTLY: deposits + wager from referred users are
          house income → emerald; commission paid out is a house cost →
          rose. Count / ratio tiles (signups, clicks, conversion, active
          creators) carry neutral accents — they aren't dollars in or
          out, so the house-POV gain/loss rule doesn't apply to them. */}
      <FadeIn>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <MetricTile
            label="Affiliate Signups"
            value={formatNumber(data.totalSignups)}
            sub="Registered via an affiliate code"
            icon={UserPlus}
            accent="blue"
          />
          {/* Commission Paid = money we sent OUT to affiliates → house
              loss → rose per CLAUDE.md house-POV rule. */}
          <MetricTile
            label="Commission Paid"
            value={formatCurrency(data.totalCommissionPaid)}
            sub="Total paid to affiliates"
            icon={DollarSign}
            accent="rose"
          />
          {/* Wager Volume = wagers from referred users → house income →
              emerald (was incorrectly blue). */}
          <MetricTile
            label="Wager Volume"
            value={formatCurrency(data.totalWagerVolume)}
            sub="From referred users"
            icon={TrendingUp}
            accent="emerald"
          />
          {/* Deposit Volume = capital in from referred users → house
              income → emerald (was cyan; deposits are emerald per the
              house-POV ledger mapping). */}
          <MetricTile
            label="Deposit Volume"
            value={formatCurrency(data.totalDepositVolume)}
            sub="From referred users"
            icon={Wallet}
            accent="emerald"
          />
          <MetricTile
            label="Total Clicks"
            value={formatNumber(data.totalClicks)}
            sub="Affiliate link clicks"
            icon={MousePointerClick}
            accent="orange"
          />
          {/* Click → signup conversion. Meaningful because signups count
              real `usage_type = 'signup'` rows rather than deposits.
              Guard against divide-by-zero when there are no clicks yet.
              Neutral accent — a ratio, not money. */}
          <MetricTile
            label="Conversion Rate"
            value={`${(data.totalClicks > 0 ? (data.totalSignups / data.totalClicks) * 100 : 0).toFixed(1)}%`}
            sub={`${formatNumber(data.totalSignups)} signups / ${formatNumber(data.totalClicks)} clicks`}
            icon={Percent}
            accent="cyan"
          />
          <MetricTile
            label="Active Creators"
            value={formatNumber(data.activeCreators)}
            sub="With active affiliate codes"
            icon={Users}
            accent="pink"
          />
        </div>
      </FadeIn>

      <FadeIn>
        <CreatorAnalyticsCharts data={data.daily} />
      </FadeIn>
    </>
  );
}
