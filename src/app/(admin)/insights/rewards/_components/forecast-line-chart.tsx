"use client";

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { formatCompactUsd, formatCurrency } from "@/lib/utils/format";

/**
 * Single-series rose area chart used by the Forecast tab for the per-
 * category historical line. Shorter than `RewardsCostChart` since the
 * forecast tab renders multiple smaller charts side-by-side; matches
 * the same rose family so the page stays cohesive.
 */
const ROSE = "#f43f5e";

const chartConfig = {
  total: { label: "Daily spend", color: ROSE },
} satisfies ChartConfig;

export function ForecastLineChart({
  data,
  height = 160,
}: {
  data: Array<{ date: string; total: number }>;
  height?: number;
}) {
  if (data.length === 0) {
    return (
      <div
        style={{ height }}
        className="grid place-items-center text-xs text-muted-foreground"
      >
        No data
      </div>
    );
  }
  return (
    <ChartContainer
      config={chartConfig}
      className="aspect-auto w-full"
      style={{ height }}
    >
      <AreaChart data={data} margin={{ left: 6, right: 6 }} accessibilityLayer>
        <defs>
          <linearGradient
            id="forecastLineGradient"
            x1="0"
            y1="0"
            x2="0"
            y2="1"
          >
            <stop offset="0%" stopColor={ROSE} stopOpacity={0.3} />
            <stop offset="100%" stopColor={ROSE} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          fontSize={10}
          tickFormatter={(v: string) => v.slice(5)}
          minTickGap={20}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={4}
          width={42}
          fontSize={10}
          tickFormatter={formatCompactUsd}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value) => formatCurrency(Number(value))}
              hideIndicator
            />
          }
        />
        <Area
          type="monotone"
          dataKey="total"
          stroke={ROSE}
          fill="url(#forecastLineGradient)"
          strokeWidth={1.5}
          animationDuration={700}
          animationEasing="ease-out"
        />
      </AreaChart>
    </ChartContainer>
  );
}
