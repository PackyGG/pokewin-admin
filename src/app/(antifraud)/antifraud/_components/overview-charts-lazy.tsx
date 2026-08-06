"use client";

import dynamic from "next/dynamic";

import { Skeleton } from "@/components/ui/skeleton";
import type { AntifraudOverviewDay } from "@/lib/antifraud/overview";
import type { CaseThroughputDay } from "@/lib/antifraud/overview-operations";

/**
 * Lazy boundary for the 30-day charts.
 *
 * The boundary has to live in a CLIENT module: `next/dynamic` called from a
 * Server Component leaves the chart's client reference inside the page's
 * initial chunk group (measured — no change in `/antifraud` First Load JS), so
 * the action feed still had to wait on Recharts before it could hydrate and
 * open its SSE stream. Declared here, the import becomes a real on-demand
 * chunk.
 *
 * Server rendering stays ON: the option that would disable it is deliberately
 * absent, and a guardrail asserts it never comes back. The charts are still
 * part of the streamed HTML — they just stop gating their neighbour's
 * JavaScript.
 */
const OverviewChartsImpl = dynamic(
  () => import("./overview-charts").then((mod) => mod.OverviewCharts),
  { loading: () => <ChartRowSkeleton /> },
);

export function ChartRowSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Skeleton className="h-[336px] w-full rounded-xl" />
      <Skeleton className="h-[336px] w-full rounded-xl" />
    </div>
  );
}

export function OverviewCharts({ days }: { days: AntifraudOverviewDay[] }) {
  return <OverviewChartsImpl days={days} />;
}

/**
 * Same treatment for the case-flow chart. Every Recharts consumer on this page
 * goes through this module — a static `recharts` import anywhere else puts the
 * library back in the initial chunk group, which the fixture guardrail fails.
 */
const OverviewThroughputChartImpl = dynamic(
  () =>
    import("./overview-throughput-chart").then(
      (mod) => mod.OverviewThroughputChart,
    ),
  { loading: () => <Skeleton className="h-[240px] w-full rounded-lg" /> },
);

export function OverviewThroughputChart({
  days,
}: {
  days: CaseThroughputDay[];
}) {
  return <OverviewThroughputChartImpl days={days} />;
}
