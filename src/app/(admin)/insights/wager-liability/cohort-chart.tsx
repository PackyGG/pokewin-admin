"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";

/**
 * Blocked-customer cohort bar chart — number of blocked customers per
 * locked-balance size band. This is a neutral COUNT, so the bars use the
 * neutral cyan accent (House-POV: counts are neutral; only money is tinted
 * red/green). Serializable props only — no function props cross the RSC
 * boundary. Animation respects reduce-motion via the chart's own
 * `animationDuration` (the house `motion-safe` convention) and the
 * recharts default honoring of the media query.
 */
export type CohortDatum = {
  label: string;
  users: number;
  lockedUsd: number;
};

const chartConfig = {
  users: { label: "Blocked customers", color: "rgb(6 182 212)" },
} satisfies ChartConfig;

export function CohortChart({ data }: { data: CohortDatum[] }) {
  return (
    <ChartContainer config={chartConfig} className="h-56 w-full">
      <BarChart data={data} accessibilityLayer margin={{ top: 8, left: -16 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          fontSize={11}
        />
        <YAxis
          allowDecimals={false}
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          width={32}
          fontSize={11}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value) => `${Number(value)} blocked`}
            />
          }
        />
        <Bar
          dataKey="users"
          fill="rgb(6 182 212)"
          fillOpacity={0.7}
          radius={[4, 4, 0, 0]}
          animationDuration={700}
          animationEasing="ease-out"
        />
      </BarChart>
    </ChartContainer>
  );
}
