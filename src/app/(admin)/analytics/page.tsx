import { BarChart3 } from "lucide-react";
import { Suspense } from "react";
import { requirePageAccess } from "@/lib/dal";
import { AutoRefresh } from "../dashboard/auto-refresh";
import { PeriodFilter } from "./period-filter";
import { PageHero } from "@/components/modern-panels";
import { AnalyticsTabNav, type AnalyticsTab } from "./tab-nav";
import { parsePeriod } from "./types";
import { OverviewTab } from "./tab-overview";
import { CohortsTab } from "./tab-cohorts";
import { FunnelTab } from "./tab-funnel";
import { LtvTab } from "./tab-ltv";
import { RetentionTab } from "./tab-retention";
import { RevenueTab } from "./tab-revenue";
import { TopPerformersTab } from "./tab-top";
import { HeatmapTab } from "./tab-heatmap";
import { PacksBattlesTab } from "./tab-packs";
import { TabSkeleton } from "./tab-skeleton";
import type { CohortGranularity } from "@/lib/queries/analytics-cohorts";

export const metadata = { title: "Analytics" };

function parseTab(value: string | undefined): AnalyticsTab {
  switch (value) {
    case "overview":
    case "cohorts":
    case "funnel":
    case "ltv":
    case "retention":
    case "revenue":
    case "top":
    case "heatmap":
    case "packs":
      return value;
    default:
      return "overview";
  }
}

function parseCohortBy(value: string | undefined): CohortGranularity {
  return value === "month" ? "month" : "week";
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/analytics");
  const params = await searchParams;
  const period = parsePeriod(params.period);
  const tab = parseTab(params.tab);
  const cohortBy = parseCohortBy(params.cohortBy);
  const topTab = params.topTab;

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

      <AnalyticsTabNav />

      {/* Each tab is an independent async segment. We render only the one
          that matches `tab` so nothing else hits the DB — important because
          several of these tabs run heavy raw SQL. Suspense + per-tab skeleton
          keeps navigation snappy between tabs. */}
      <Suspense
        key={`${tab}-${period}-${cohortBy}-${topTab ?? ""}`}
        fallback={<TabSkeleton />}
      >
        {tab === "overview" && <OverviewTab period={period} />}
        {tab === "cohorts" && (
          <CohortsTab period={period} granularity={cohortBy} />
        )}
        {tab === "funnel" && <FunnelTab period={period} />}
        {tab === "ltv" && <LtvTab period={period} />}
        {tab === "retention" && <RetentionTab period={period} />}
        {tab === "revenue" && <RevenueTab period={period} />}
        {tab === "top" && (
          <TopPerformersTab period={period} subTab={topTab} />
        )}
        {tab === "heatmap" && <HeatmapTab period={period} />}
        {tab === "packs" && <PacksBattlesTab period={period} />}
      </Suspense>
    </div>
  );
}
