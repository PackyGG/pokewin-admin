import { Suspense } from "react";
import { BarChart3, CalendarDays } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { AutoRefresh } from "../dashboard/auto-refresh";
import { SkeletonChart } from "@/components/ux";
import { TileErrorFallback } from "@/components/tile-error-fallback";
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

      <header className="flex flex-col gap-4 border-b pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-2xl">
          <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-primary">
            <BarChart3 className="size-3.5" aria-hidden />
            Analytics 2
          </div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Customer growth at a glance
          </h1>
          <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
            A clean daily view of account creation and depositor activity.
          </p>
        </div>
        <Analytics2PeriodFilter period={period} />
      </header>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <CalendarDays className="size-3.5" aria-hidden />
        {ANALYTICS_2_PERIOD_LABELS[period]} · UTC · refreshes every 5 minutes
      </div>

      <Suspense
        key={period}
        fallback={<SkeletonChart height={390} variant="area" />}
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

  return <AcquisitionChart data={result.points} />;
}
