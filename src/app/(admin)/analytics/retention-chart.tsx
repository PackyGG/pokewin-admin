"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";

const chartConfig = {
  pct: { label: "Retention", color: "var(--color-chart-1)" },
} satisfies ChartConfig;

/**
 * Retention curve. X = days since signup. Y = % of cohort still placing
 * wagers. Reference lines at day 7 / 30 / 90 so the admin can read off
 * milestone values without squinting at the x-axis.
 */
export function RetentionChart({
  curve,
}: {
  curve: { day: number; pct: number; retained: number; cohort: number }[];
}) {
  const data = curve.map((c) => ({
    day: c.day,
    pct: c.pct * 100,
    retained: c.retained,
    cohort: c.cohort,
  }));

  return (
    <ChartContainer config={chartConfig} className="h-[260px] w-full md:h-[320px] lg:h-[360px]">
      <AreaChart data={data} accessibilityLayer>
        <defs>
          <linearGradient id="retention-gradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-pct)" stopOpacity={0.4} />
            <stop offset="100%" stopColor="var(--color-pct)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="day"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          tickFormatter={(v) => `d${v}`}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          width={50}
          tickFormatter={(v) => `${v.toFixed(0)}%`}
          domain={[0, (dataMax: number) => Math.max(10, Math.ceil(dataMax + 5))]}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(value) => `Day ${value} after signup`}
              formatter={(value) => `${Number(value).toFixed(1)}%`}
            />
          }
        />
        <ReferenceLine
          x={7}
          stroke="var(--muted-foreground)"
          strokeDasharray="3 3"
          strokeOpacity={0.5}
          label={{ value: "d7", position: "top", fontSize: 10 }}
        />
        <ReferenceLine
          x={30}
          stroke="var(--muted-foreground)"
          strokeDasharray="3 3"
          strokeOpacity={0.5}
          label={{ value: "d30", position: "top", fontSize: 10 }}
        />
        <ReferenceLine
          x={90}
          stroke="var(--muted-foreground)"
          strokeDasharray="3 3"
          strokeOpacity={0.5}
          label={{ value: "d90", position: "top", fontSize: 10 }}
        />
        <Area
          type="monotone"
          dataKey="pct"
          stroke="var(--color-pct)"
          strokeWidth={2}
          fill="url(#retention-gradient)"
          animationDuration={700}
          animationEasing="ease-out"
        />
      </AreaChart>
    </ChartContainer>
  );
}
