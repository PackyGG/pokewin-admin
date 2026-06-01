"use client";

import {
  Line,
  LineChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { formatNumber } from "@/lib/utils/format";

/**
 * Tiny per-country trend line chart. Two series — daily signups
 * (blue) and daily claimers (rose).
 *
 * Height fixed at 140px so 5 country panels fit on one screen
 * without scrolling.
 */
export function GeoTrendChart({
  daily,
}: {
  daily: Array<{ date: string; signups: number; claimers: number }>;
}) {
  const config = {
    signups: { label: "Signups", color: "#3b82f6" },
    claimers: { label: "Claimers", color: "#f43f5e" },
  } satisfies ChartConfig;
  return (
    <ChartContainer
      config={config}
      className="aspect-auto w-full"
      style={{ height: 140 }}
    >
      <LineChart data={daily} margin={{ left: 4, right: 4, top: 4 }} accessibilityLayer>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          fontSize={10}
          minTickGap={28}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          width={36}
          tickFormatter={(v) => formatNumber(Number(v))}
          fontSize={10}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value) => formatNumber(Number(value))}
              hideIndicator
            />
          }
        />
        <Line
          type="monotone"
          dataKey="signups"
          stroke="#3b82f6"
          strokeWidth={2}
          dot={false}
          animationDuration={700}
          animationEasing="ease-out"
        />
        <Line
          type="monotone"
          dataKey="claimers"
          stroke="#f43f5e"
          strokeWidth={2}
          dot={false}
          animationDuration={700}
          animationEasing="ease-out"
        />
      </LineChart>
    </ChartContainer>
  );
}
