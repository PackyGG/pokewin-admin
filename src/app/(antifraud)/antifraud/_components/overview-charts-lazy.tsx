"use client";

import dynamic from "next/dynamic";

import { Skeleton } from "@/components/ui/skeleton";
import type { AntifraudOverviewDay } from "@/lib/antifraud/overview";

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
