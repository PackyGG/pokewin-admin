"use client";

import * as React from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
} from "recharts";

import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import type { CaseThroughputDay } from "@/lib/antifraud/overview-operations";

/**
 * Case flow: what arrived versus what was decided, per day.
 *
 * Bars are decisions (the work finished, split by verdict), the line is cases
 * opened (the work arriving). The line sitting above the bars for several days
 * running IS the backlog forming — that is the whole point of the panel, and
 * why the two series share one axis instead of being two charts.
 *
 * Lives in its own module for the same reason `overview-charts.tsx` does:
 * Recharts must stay out of the page's initial chunk group. It is reached only
 * through the client lazy boundary in `overview-charts-lazy.tsx`.
 *
 * Colours are RISK colours, matching `REVIEW_STATUS_COLORS`: flagged is the
 * bad outcome (rose), cleared is the clean one (emerald), arrivals are neutral
 * (blue). No money is plotted here, so the House-POV money rule does not
 * apply — and must not be borrowed, or "flagged" would read as a good day.
 */

const throughputConfig = {
  cleared: { label: "Cleared", color: "var(--color-emerald-500)" },
  flagged: { label: "Flagged", color: "var(--color-rose-500)" },
  opened: { label: "Opened", color: "var(--color-blue-500)" },
} satisfies ChartConfig;

function dateLabel(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
}

export function OverviewThroughputChart({
  days,
}: {
  days: CaseThroughputDay[];
}) {
  const reducedMotion = useReducedMotion();

  return (
    // Fixed height + aspect-auto for the same reason as the other charts:
    // ChartContainer's default `aspect-video` lets ResponsiveContainer
    // re-measure its own growth inside a flexible parent.
    <ChartContainer
      config={throughputConfig}
      className="aspect-auto h-[240px] w-full"
    >
      <ComposedChart
        data={days}
        accessibilityLayer
        margin={{ top: 8, right: 8, left: -12, bottom: 0 }}
      >
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={dateLabel}
          tickLine={false}
          axisLine={false}
          minTickGap={24}
        />
        <YAxis
          allowDecimals={false}
          tickLine={false}
          axisLine={false}
          width={40}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(value) => dateLabel(String(value))}
            />
          }
        />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar
          dataKey="cleared"
          stackId="decided"
          fill="var(--color-cleared)"
          radius={[0, 0, 0, 0]}
          isAnimationActive={!reducedMotion}
          animationDuration={700}
          animationEasing="ease-out"
        />
        <Bar
          dataKey="flagged"
          stackId="decided"
          fill="var(--color-flagged)"
          radius={[2, 2, 0, 0]}
          isAnimationActive={!reducedMotion}
          animationDuration={700}
          animationEasing="ease-out"
        />
        <Line
          type="monotone"
          dataKey="opened"
          stroke="var(--color-opened)"
          strokeWidth={2}
          dot={false}
          isAnimationActive={!reducedMotion}
          animationDuration={700}
          animationEasing="ease-out"
        />
      </ComposedChart>
    </ChartContainer>
  );
}
