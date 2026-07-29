import { Suspense } from "react";
import {
  ArrowDownToLine,
  LineChart,
  UserPlus,
  UsersRound,
} from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { AutoRefresh } from "../dashboard/auto-refresh";
import { SkeletonChart, SkeletonKpiStrip } from "@/components/ux";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import {
  KpiTile,
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { getAcquisitionTrend } from "@/lib/queries/analytics-2";
import { AcquisitionChart } from "./acquisition-chart";
import { Analytics2PeriodFilter } from "./period-filter";
import {
  ANALYTICS_2_PERIOD_LABELS,
  parseAnalytics2Period,
  type Analytics2Period,
} from "./types";

export const metadata = { title: "Analytics 2" };

export default async function Analytics2Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/analytics");
  const params = await searchParams;
  const period = parseAnalytics2Period(params.period);

  return (
    <div className="space-y-5 sm:space-y-6">
      <AutoRefresh intervalMs={300_000} />

      <PageHero>
        <PageHeroIdentity
          icon={LineChart}
          title="Analytics 2"
          subtitle="Daily account creation and depositor activity."
          action={<Analytics2PeriodFilter period={period} />}
        />
      </PageHero>

      <Suspense
        key={period}
        fallback={
          <div className="space-y-5 sm:space-y-6">
            <SkeletonKpiStrip count={3} className="sm:grid-cols-3" />
            <SkeletonChart height={300} variant="area" />
          </div>
        }
      >
        <AcquisitionSection period={period} />
      </Suspense>
    </div>
  );
}

async function AcquisitionSection({
  period,
}: {
  period: Analytics2Period;
}) {
  const result = await getAcquisitionTrend(period);

  if (!result.available) {
    return (
      <TileErrorFallback
        label="Acquisition activity"
        hint="Live data is temporarily unavailable. The next automatic refresh will retry it."
        size="panel"
      />
    );
  }

  const latest = result.points.at(-1) ?? {
    date: "",
    signups: 0,
    ftds: 0,
    existingDepositors: 0,
  };
  const totals = result.points.reduce(
    (sum, point) => ({
      signups: sum.signups + point.signups,
      ftds: sum.ftds + point.ftds,
      existingDepositors: sum.existingDepositors + point.existingDepositors,
    }),
    { signups: 0, ftds: 0, existingDepositors: 0 },
  );

  return (
    <div className="space-y-5 sm:space-y-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
        <KpiTile
          label="Sign-ups"
          value={totals.signups.toLocaleString("en-US")}
          sub={`${latest.signups.toLocaleString("en-US")} today`}
          icon={UserPlus}
          accent="blue"
        />
        <KpiTile
          label="First-time depositors"
          value={totals.ftds.toLocaleString("en-US")}
          sub={`${latest.ftds.toLocaleString("en-US")} today`}
          icon={ArrowDownToLine}
          accent="emerald"
        />
        <KpiTile
          label="Existing depositors"
          value={totals.existingDepositors.toLocaleString("en-US")}
          sub={`${latest.existingDepositors.toLocaleString("en-US")} today`}
          icon={UsersRound}
          accent="purple"
        />
      </div>

      <div className="space-y-3">
        <SectionHeading
          icon={LineChart}
          title="Daily acquisition"
          action={
            <span className="text-xs text-muted-foreground">
              {ANALYTICS_2_PERIOD_LABELS[period]} · UTC · refreshes every 5
              minutes
            </span>
          }
        />
        <AcquisitionChart data={result.points} />
      </div>
    </div>
  );
}
