import { Suspense } from "react";
import {
  LineChart,
  DollarSign,
  MousePointerClick,
  UserPlus,
  Percent,
  TrendingUp,
  Users,
  Wallet,
  Check,
  Filter,
} from "lucide-react";

import { requireCreatorHubPageAccess } from "@/lib/require-creator-hub-access";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DASHBOARD_PERIOD_LABELS,
} from "@/lib/queries/dashboard-period";
import { getAffiliateAnalytics } from "@/lib/queries/creators";
import { getFunnelData } from "@/lib/queries/analytics-funnel";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

import { HubKpiBox } from "../_components/hub-kpi-box";
import { HubAcquisitionPeriodSelector } from "./_components/hub-acquisition-period-selector";
import { AcquisitionCharts } from "./_components/acquisition-charts";
import { AcquisitionFunnel } from "./_components/acquisition-funnel";
import {
  parseAcquisitionHubPeriod,
  hubPeriodToAffiliateAnalytics,
  hubPeriodToFunnelPeriod,
  type AcquisitionHubPeriod,
} from "./_lib/period";

export const metadata = { title: "Acquisition · Creator Hub" };

/**
 * Creator Hub → Acquisition.
 *
 * Hub-styled port of `/creators/analytics`: affiliate performance KPIs,
 * daily trend charts (recharts emerald/rose house-POV), and the platform
 * acquisition funnel (clicks → signup → FTD → wager → repeat → MAW).
 *
 * Reuses the EXISTING data layer — `getAffiliateAnalytics` +
 * `getFunnelData` — no duplicated SQL.
 *
 * ACCESS: `canAccessCreatorHub` (founder `motha`, or a role whose
 * ADMIN-DB toggle is on). The Hub layout enforces it; this page adds the
 * explicit gate per the house convention.
 *
 * ACTIVE-TIMEFRAME-ONLY: period selector defaults to 24h; the data
 * section is wrapped in `<Suspense key={period}>` so only the active
 * window is queried on first render and switching lazily loads just that
 * window (never preloading all windows).
 */
export default async function CreatorHubAcquisitionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireCreatorHubPageAccess();

  const period = parseAcquisitionHubPeriod((await searchParams).period);
  const windowLabel = DASHBOARD_PERIOD_LABELS[period].toLowerCase();

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <PageHeroIdentity
            icon={LineChart}
            accent="pink"
            title="Acquisition"
            subtitle={`Affiliate performance — signups, FTDs, commission, wagers · ${windowLabel}`}
          />
          <HubAcquisitionPeriodSelector current={period} />
        </div>
      </PageHero>

      <Suspense key={period} fallback={<AcquisitionSkeleton />}>
        <AcquisitionSection period={period} />
      </Suspense>
    </div>
  );
}

// ─── Data section (streamed via Suspense) ─────────────────────────────

async function AcquisitionSection({ period }: { period: AcquisitionHubPeriod }) {
  const analyticsPeriod = hubPeriodToAffiliateAnalytics(period);
  const funnelPeriod = hubPeriodToFunnelPeriod(period);

  const [data, funnel] = await Promise.all([
    getAffiliateAnalytics(analyticsPeriod),
    getFunnelData(funnelPeriod),
  ]);

  const ftdCount =
    funnel.steps.find((s) => s.key === "first_deposit")?.count ?? 0;
  const conversionPct =
    data.totalClicks > 0
      ? ((data.totalSignups / data.totalClicks) * 100).toFixed(1)
      : "0.0";

  return (
    <FadeIn className="space-y-6">
      {/* KPI strip — house-POV via HubKpiBox accents:
            emerald = house income (wager, deposits)
            rose    = house cost (commission paid)
            blue    = neutral funnel counts (signups, clicks, FTDs, conversion, creators) */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <HubKpiBox
          label="Affiliate Signups"
          value={formatNumber(data.totalSignups)}
          sub="Registered via an affiliate code"
          icon={UserPlus}
          accent="blue"
        />
        <HubKpiBox
          label="FTDs"
          value={formatNumber(ftdCount)}
          sub="First-time depositors in cohort"
          icon={Check}
          accent="blue"
        />
        <HubKpiBox
          label="Commission Paid"
          value={formatCurrency(data.totalCommissionPaid)}
          sub="Total paid to affiliates"
          icon={DollarSign}
          accent="rose"
        />
        <HubKpiBox
          label="Wager Volume"
          value={formatCurrency(data.totalWagerVolume)}
          sub="From referred users"
          icon={TrendingUp}
          accent="emerald"
        />
        <HubKpiBox
          label="Deposit Volume"
          value={formatCurrency(data.totalDepositVolume)}
          sub="From referred users"
          icon={Wallet}
          accent="emerald"
        />
        <HubKpiBox
          label="Total Clicks"
          value={formatNumber(data.totalClicks)}
          sub="Affiliate link clicks"
          icon={MousePointerClick}
          accent="blue"
        />
        <HubKpiBox
          label="Conversion Rate"
          value={`${conversionPct}%`}
          sub={`${formatNumber(data.totalSignups)} signups / ${formatNumber(data.totalClicks)} clicks`}
          icon={Percent}
          accent="blue"
        />
        <HubKpiBox
          label="Active Creators"
          value={formatNumber(data.activeCreators)}
          sub="With active affiliate codes"
          icon={Users}
          accent="blue"
        />
      </div>

      <div className="space-y-3">
        <SectionHeading icon={LineChart} title="Daily trends" />
        <AcquisitionCharts data={data.daily} />
      </div>

      <div className="space-y-3">
        <SectionHeading icon={Filter} title="Conversion funnel" />
        <AcquisitionFunnel period={funnelPeriod} data={funnel} />
      </div>
    </FadeIn>
  );
}

// ─── Skeleton ─────────────────────────────────────────────────────────

function AcquisitionSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-[104px] rounded-2xl" />
        ))}
      </div>
      <div className="space-y-3">
        <Skeleton className="h-5 w-32 rounded" />
        <div className="grid gap-4 lg:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-[340px] rounded-2xl" />
          ))}
        </div>
      </div>
      <div className="space-y-3">
        <Skeleton className="h-5 w-40 rounded" />
        <Skeleton className="h-[420px] rounded-2xl" />
      </div>
    </div>
  );
}
